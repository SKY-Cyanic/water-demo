// Spectral ocean: JONSWAP spectrum -> GPU inverse FFT -> displacement textures.
//
// Per frame, for each cascade:
//   1. evolve  h(k,t) = h0(k) e^{i w t} + conj(h0(-k)) e^{-i w t}
//      and build three packed complex fields from it
//   2. inverse-transform all fields of all cascades in one batched FFT
//   3. unpack into two RGBA16F textures the water material samples
//
// Two real fields ride in each complex transform (C = A + iB inverse-transforms
// to A + iB in the spatial domain, provided both spectra are Hermitian), so six
// real outputs cost three transforms rather than six:
//
//   field 0 -> displacement Y , displacement X
//   field 1 -> displacement Z , dY/dx
//   field 2 -> dY/dz          , horizontal divergence
//
// The divergence dDx/dx + dDz/dz is the folding metric: it is what the Gerstner
// path gets from its analytic Jacobian, and it drives foam the same way, so both
// wave engines feed the surface shader the same quantities.
//
// Requires WebGPU. The Gerstner path in waves.js stays the engine for the
// WebGL 2 fallback and the Low tier, which have no compute shaders.

import { HalfFloatType, LinearFilter, RGBAFormat, RepeatWrapping, StorageTexture, Vector2 } from 'three/webgpu';
import {
	Fn, float, floor, instanceIndex, int, ivec2, cos, sin, sqrt, max, texture, textureStore,
	uniform, vec2, vec4, attributeArray,
} from 'three/tsl';

import { GRAVITY, TAU } from '../core/util.js';
import { BatchedFFT } from './fft.js';
import { CASCADES, buildInitialSpectrum, significantHeightOf } from './spectrum.js';

const FIELDS = 3;

export const SPECTRAL_TIERS = {
	medium: { N: 128 },
	high: { N: 256 },
	ultra: { N: 256 },
};

export class SpectralOcean {

	/**
	 * @param {Renderer} renderer
	 * @param {object} env
	 * @param {number} N     grid resolution per cascade
	 * @param {number} seed
	 */
	constructor( renderer, env, N, seed ) {

		this.renderer = renderer;
		this.env = env;
		this.N = N;
		this.seed = seed;
		this.cascades = CASCADES;

		const C = this.cascades.length;

		this.fft = new BatchedFFT( N, C * FIELDS );

		// h0 and conj(h0(-k)) packed per texel, for every cascade.
		this.h0 = attributeArray( C * N * N, 'vec4' );
		this.h0.setName( 'oceanH0' );

		// Outputs. Two textures per cascade:
		//   A = (Dx, Dy, Dz, divergence)
		//   B = (dY/dx, dY/dz, 0, 0)
		this.dispTextures = [];
		this.slopeTextures = [];

		for ( let c = 0; c < C; c ++ ) {

			this.dispTextures.push( this._makeTexture( N, `oceanDisp${c}` ) );
			this.slopeTextures.push( this._makeTexture( N, `oceanSlope${c}` ) );

		}

		// Per-cascade domain size, as a uniform array is not needed — the kernels
		// index cascades directly, so a small uniform per cascade is simpler.
		this.uTime = uniform( 0 );
		this.uAmplitude = uniform( 1 );
		this.uChoppy = uniform( 1 );

		this.uSizes = uniform( new Vector2() );   // unused placeholder, see below
		this.cascadeSize = this.cascades.map( ( c ) => c.size );

		this._buildKernels();

		this.rebuild( env.params );

	}

	_makeTexture( N, name ) {

		const t = new StorageTexture( N, N );
		t.name = name;
		t.format = RGBAFormat;
		t.type = HalfFloatType;
		t.minFilter = LinearFilter;
		t.magFilter = LinearFilter;
		t.wrapS = RepeatWrapping;
		t.wrapT = RepeatWrapping;
		t.generateMipmaps = false;
		return t;

	}

	_buildKernels() {

		const N = this.N;
		const C = this.cascades.length;
		const sizes = this.cascadeSize;

		/* ---------------------------------------------------- time evolution */

		this.evolveKernel = Fn( () => {

			const idx = float( instanceIndex ).toVar( 'specIdx' );

			const x = idx.mod( N ).toVar( 'specX' );
			const rest = floor( idx.div( N ) ).toVar( 'specRest' );
			const z = rest.mod( N ).toVar( 'specZ' );
			const casc = floor( rest.div( N ) ).toVar( 'specC' );

			// Domain size for this cascade, selected without branching.
			const L = float( 0 ).toVar( 'specL' );
			for ( let c = 0; c < C; c ++ ) {

				L.addAssign( float( sizes[ c ] ).mul( float( 1 ).sub( casc.sub( c ).abs().min( 1 ) ) ) );

			}

			const dk = float( TAU ).div( L ).toVar( 'specDk' );

			const kx = x.sub( N / 2 ).mul( dk ).toVar( 'specKx' );
			const kz = z.sub( N / 2 ).mul( dk ).toVar( 'specKz' );
			const kLen = max( sqrt( kx.mul( kx ).add( kz.mul( kz ) ) ), float( 1e-6 ) ).toVar( 'specK' );

			const h0v = this.h0.element( int( idx ) ).toVar( 'specH0' );

			const omega = sqrt( float( GRAVITY ).mul( kLen ) ).toVar( 'specOmega' );
			const wt = omega.mul( this.uTime ).toVar( 'specWt' );
			const c = cos( wt ).toVar( 'specCos' );
			const s = sin( wt ).toVar( 'specSin' );

			// h = h0 * e^{i wt} + conj(h0(-k)) * e^{-i wt}
			const hr = h0v.x.mul( c ).sub( h0v.y.mul( s ) )
				.add( h0v.z.mul( c ).add( h0v.w.mul( s ) ) ).toVar( 'specHr' );
			const hi = h0v.x.mul( s ).add( h0v.y.mul( c ) )
				.add( h0v.w.mul( c ).sub( h0v.z.mul( s ) ) ).toVar( 'specHi' );

			const h = vec2( hr, hi ).toVar( 'specH' );

			// i*h, used repeatedly below.
			const ih = vec2( hi.negate(), hr ).toVar( 'specIH' );

			const knx = kx.div( kLen ).toVar( 'specKnx' );
			const knz = kz.div( kLen ).toVar( 'specKnz' );

			// pack(A, B) = A + i*B  for complex A, B
			const pack = ( ax, ay, bx, by ) => vec2( ax.sub( by ), ay.add( bx ) );

			// field 0: Dy , Dx        Dx spectrum = i * kx/|k| * h
			const dxr = ih.x.mul( knx );
			const dxi = ih.y.mul( knx );
			const f0 = pack( h.x, h.y, dxr, dxi );

			// field 1: Dz , dY/dx     Dz = i * kz/|k| * h ,  dY/dx = i * kx * h
			const dzr = ih.x.mul( knz );
			const dzi = ih.y.mul( knz );
			const sxr = ih.x.mul( kx );
			const sxi = ih.y.mul( kx );
			const f1 = pack( dzr, dzi, sxr, sxi );

			// field 2: dY/dz , divergence     div = -|k| * h
			const szr = ih.x.mul( kz );
			const szi = ih.y.mul( kz );
			const dvr = h.x.mul( kLen ).negate();
			const dvi = h.y.mul( kLen ).negate();
			const f2 = pack( szr, szi, dvr, dvi );

			const cellBase = z.mul( N ).add( x ).toVar( 'specCell' );
			const planeStride = float( N * N );

			this.fft.a.element( int( casc.mul( FIELDS ).mul( planeStride ).add( cellBase ) ) ).assign( f0 );
			this.fft.a.element( int( casc.mul( FIELDS ).add( 1 ).mul( planeStride ).add( cellBase ) ) ).assign( f1 );
			this.fft.a.element( int( casc.mul( FIELDS ).add( 2 ).mul( planeStride ).add( cellBase ) ) ).assign( f2 );

		} )().compute( C * N * N );

		/* --------------------------------------------------------- unpacking */

		this.packKernels = [];

		for ( let c = 0; c < C; c ++ ) {

			const dispTex = this.dispTextures[ c ];
			const slopeTex = this.slopeTextures[ c ];

			this.packKernels.push( Fn( () => {

				const idx = float( instanceIndex ).toVar( 'packIdx' );
				const x = idx.mod( N ).toVar( 'packX' );
				const z = floor( idx.div( N ) ).toVar( 'packZ' );

				const cell = z.mul( N ).add( x );
				const base = float( c * FIELDS * N * N );

				const p0 = this.fft.a.element( int( base.add( cell ) ) ).toVar( 'packP0' );
				const p1 = this.fft.a.element( int( base.add( N * N ).add( cell ) ) ).toVar( 'packP1' );
				const p2 = this.fft.a.element( int( base.add( 2 * N * N ).add( cell ) ) ).toVar( 'packP2' );

				// The wavevector grid is centred on N/2, so the transform result
				// carries a (-1)^(x+z) phase that has to be undone here.
				const parity = x.add( z ).mod( 2.0 ).toVar( 'packParity' );
				const sgn = float( 1 ).sub( parity.mul( 2 ) ).toVar( 'packSign' );

				const amp = this.uAmplitude.mul( sgn ).toVar( 'packAmp' );

				const dy = p0.x.mul( amp );
				const dx = p0.y.mul( amp ).mul( this.uChoppy );
				const dz = p1.x.mul( amp ).mul( this.uChoppy );
				const dYdx = p1.y.mul( amp );
				const dYdz = p2.x.mul( amp );
				// Raw, *not* scaled by choppiness. uChoppy is how far the surface is
				// displaced horizontally; it has no business shrinking the folding
				// metric by 20% before the whitecap test even sees it.
				const divergence = p2.y.mul( amp );

				textureStore( dispTex, ivec2( int( x ), int( z ) ), vec4( dx, dy, dz, divergence ) ).toStack();
				textureStore( slopeTex, ivec2( int( x ), int( z ) ), vec4( dYdx, dYdz, 0, 1 ) ).toStack();

			} )().compute( N * N ) );

		}

	}

	/**
	 * Regenerate the initial spectrum. Called when wind or wave parameters
	 * change — not per frame.
	 */
	rebuild( params ) {

		const N = this.N;
		const buffers = [];

		for ( let c = 0; c < this.cascades.length; c ++ ) {

			buffers.push( buildInitialSpectrum( this.cascades[ c ], N, params, this.seed ) );

		}

		// Normalise so the "wave height" slider means significant wave height in
		// metres — the same thing it means on the Gerstner path. Without this the
		// sea state would jump whenever the quality tier switched wave engines.
		const hs = significantHeightOf( buffers );
		this.normalisation = hs > 1e-6 ? 1 / hs : 0;

		const target = this.h0.value.array;
		let offset = 0;

		for ( const b of buffers ) {

			target.set( b, offset );
			offset += b.length;

		}

		this.h0.value.needsUpdate = true;

	}

	/** Advance one frame. Must run before the scene render. */
	update( time, params ) {

		this.uTime.value = time;
		this.uAmplitude.value = this.normalisation * params.waveHeight;
		this.uChoppy.value = params.waveChoppy;

		const renderer = this.renderer;

		renderer.compute( this.evolveKernel );
		this.fft.run( renderer, 1 );

		for ( const k of this.packKernels ) renderer.compute( k );

	}

	/**
	 * Raw textures for the surface material.
	 *
	 * Deliberately not pre-wrapped in texture() nodes: the material needs to
	 * sample these at an explicit LOD (there are no mipmaps, and the vertex stage
	 * has no derivatives to pick one with), so it builds its own sampler nodes.
	 */
	get textures() {

		return {
			disp: this.dispTextures,
			slope: this.slopeTextures,
			sizes: this.cascadeSize,
			// Where each cascade stops being resolvable. Driven by the band of
			// wavelengths it carries, not by its texel size.
			fade: [
				[ 3000, 14000 ],   // swell,     > 114 m
				[ 500, 2600 ],    // wind sea,  18-114 m
				[ 70, 340 ],     // chop,      < 18 m
			],
			// The fragment stage can afford to keep detail alive further out than
			// the mesh can carry it.
			slopeFade: [
				[ 4000, 20000 ],
				[ 900, 4200 ],
				[ 120, 700 ],
			],
		};

	}

	dispose() {

		this.fft.dispose();
		for ( const t of this.dispTextures ) t.dispose();
		for ( const t of this.slopeTextures ) t.dispose();

	}

}
