// Gerstner (trochoidal) wave field.
//
// Surface point for a rest position p0 = (x0, z0), summed over N components:
//
//     theta_i = k_i * dot(D_i, p0) - w_i * t + phi_i
//     Y       = sum( A_i * cos(theta_i) )
//     XZ      = p0 - sum( H_i * D_i * sin(theta_i) )
//
// with the deep-water dispersion relation w_i = sqrt(g * k_i), so every
// component travels at its own physically-correct speed. That is what stops the
// sum from reading as one sheet sliding in a single direction, and it is why
// the pattern does not visibly loop: the periods are mutually irrational.
//
// Steepness budget
// ----------------
// Writing H_i = choppy * qw_i / k_i (rather than the usual Q_i * A_i) makes the
// horizontal term independent of amplitude, and the fold condition collapses to
//
//     sum( k_i * H_i ) = choppy * sum( qw_i ) = choppy
//
// so with sum(qw_i) normalised to 1, any choppy <= 1 is provably fold-free at
// every wave height. No vertex inversion, no clamping hacks.
//
// Derivatives are analytic, so the normal is exact for the displaced surface and
// the horizontal Jacobian gives a true compression measure for foam:
//
//     dX/dx0 = 1 - Jxx    dX/dz0 = dZ/dx0 = -Jxz    dZ/dz0 = 1 - Jzz
//     J      = (1-Jxx)(1-Jzz) - Jxz^2        ->  1 = flat, -> 0 = folding

import { Vector4 } from 'three/webgpu';
import { Break, Fn, If, Loop, cos, cross, dot, float, normalize, oneMinus, saturate, sin, smoothstep, uniformArray, vec2, vec3 } from 'three/tsl';
import { GRAVITY, TAU, mulberry32 } from '../core/util.js';

/**
 * Wavelength bands, in metres. Splitting the spectrum into explicit bands lets
 * each one get its own directional spread: long swell arrives in a tight fan,
 * short chop is nearly isotropic. A single spread value for all scales is what
 * makes naive Gerstner oceans look like corrugated iron.
 */
const BANDS = [
	// [ minLambda, maxLambda, share of components, directional spread (rad), choppiness weight ]
	{ min: 60, max: 240, share: 0.22, spread: 0.42, chop: 0.85 },  // swell
	{ min: 13, max: 52, share: 0.38, spread: 1.05, chop: 1.30 },  // wind sea
	{ min: 1.8, max: 11, share: 0.40, spread: 1.85, chop: 1.15 },  // chop
];

export class WaveField {

	/**
	 * @param {number} seed   deterministic — the same seed always builds the same ocean
	 * @param {number} count  number of Gerstner components
	 */
	constructor( seed = 20250731, count = 20 ) {

		this.seed = seed;
		this.count = count;

		// wA[i] = ( D.x, D.z, k, omega )
		// wB[i] = ( amplitude, H, phase, fadeEnd )
		this.wA = [];
		this.wB = [];

		for ( let i = 0; i < count; i ++ ) {

			this.wA.push( new Vector4() );
			this.wB.push( new Vector4() );

		}

		this.uWA = uniformArray( this.wA );
		this.uWB = uniformArray( this.wB );

		// Scratch for the CPU-side height solve; never reallocated.
		this._sx = 0;
		this._sz = 0;

		this.build( { windSpeed: 9, windAngle: 40, waveScale: 1 }, 0.035 );

	}

	/**
	 * Regenerate component parameters.
	 *
	 * Cheap enough (20 components) to call on any wind/scale slider change, which
	 * keeps the shader free of per-component spectrum maths.
	 *
	 * @param {object} p                 { windSpeed, windAngle, waveScale }
	 * @param {number} vertexGrowthRate  radial vertex spacing growth of the ocean
	 *                                   mesh — spacing(r) ~= r * rate. Used to
	 *                                   decide where each component stops being
	 *                                   resolvable and must fade out.
	 */
	build( p, vertexGrowthRate ) {

		const rnd = mulberry32( this.seed );
		const windRad = p.windAngle * Math.PI / 180;
		const scale = Math.max( 0.25, p.waveScale );

		// Pierson-Moskowitz peak wavelength for a fully developed sea.
		const U = Math.max( 0.5, p.windSpeed );
		const lambdaPeak = TAU * U * U / GRAVITY;
		// Phillips cutoff length: energy above this wavelength is suppressed.
		const Lw = U * U / GRAVITY;

		const raw = [];

		for ( let b = 0; b < BANDS.length; b ++ ) {

			const band = BANDS[ b ];
			const n = Math.max( 1, Math.round( this.count * band.share ) );

			for ( let j = 0; j < n; j ++ ) {

				// Stratified sampling inside the band (log-spaced) plus jitter, so
				// components never collide onto the same wavelength.
				const u0 = ( j + rnd() * 0.85 + 0.075 ) / n;
				const lambda = band.min * Math.pow( band.max / band.min, u0 ) * scale;

				const k = TAU / lambda;
				const omega = Math.sqrt( GRAVITY * k );

				// Direction: wind heading plus a band-dependent spread. The cubic
				// bias keeps most energy near the wind axis while still allowing
				// the occasional strongly oblique component.
				const r = rnd() * 2 - 1;
				const theta = windRad + r * r * r * band.spread + ( rnd() - 0.5 ) * 0.12;
				const dx = Math.sin( theta );
				const dz = Math.cos( theta );

				// Phillips-style envelope: exp(-1/(k*Lw)^2) kills wavelengths well
				// above the wind-driven peak.
				//
				// The 0.45 exponent on the short side is deliberately much gentler
				// than Phillips' own 1/k^2. Strict Phillips is correct for the
				// energy spectrum but wrong for a 20-component sum: it concentrates
				// everything into the peak, leaving no slope variance at small
				// scales — and slope variance is exactly what produces sun glitter
				// and surface texture. Flattening it is the difference between an
				// ocean and a swimming pool.
				const kl = Math.max( 1e-4, k * Lw );
				const cutoff = Math.exp( - 1 / ( kl * kl ) );
				const spectral = Math.sqrt( cutoff ) * Math.pow( lambda / lambdaPeak, 0.45 );

				// Directional response relative to the wind.
				const dirFactor = Math.pow( Math.abs( Math.cos( theta - windRad ) ), 1.2 );

				const amp = Math.max( 1e-5, spectral * ( 0.55 + dirFactor * 0.45 ) );

				raw.push( {
					dx, dz, k, omega, amp, lambda,
					phase: rnd() * TAU,
					chopW: band.chop * ( 0.7 + rnd() * 0.6 ),
				} );

			}

		}

		// Longest first. Combined with the early-out in the shader loop, distant
		// vertices evaluate only the swell components they can actually resolve.
		raw.sort( ( a, b ) => b.lambda - a.lambda );

		// Normalise amplitudes so the significant wave height ~= 4 * sigma is 1
		// at waveHeight = 1. The user-facing slider is then "Hs in metres".
		let variance = 0;
		for ( const w of raw ) variance += w.amp * w.amp * 0.5;
		const ampNorm = 1 / Math.max( 1e-6, 4 * Math.sqrt( variance ) );

		// Normalise the choppiness weights so sum(k*H) == choppy exactly.
		let chopSum = 0;
		for ( const w of raw ) chopSum += w.chopW;
		const chopNorm = 1 / Math.max( 1e-6, chopSum );

		// A component of wavelength L needs vertex spacing < L/4 to survive.
		// spacing(r) ~= r * growth  =>  it dies at r = L / (4 * growth).
		const fadeK = 1 / ( 4 * Math.max( 1e-4, vertexGrowthRate ) );

		const n = Math.min( raw.length, this.count );
		this.active = n;

		for ( let i = 0; i < n; i ++ ) {

			const w = raw[ i ];
			const A = w.amp * ampNorm;
			const H = w.chopW * chopNorm / w.k;

			this.wA[ i ].set( w.dx, w.dz, w.k, w.omega );
			this.wB[ i ].set( A, H, w.phase, w.lambda * fadeK );

		}

		// Any unused slots must contribute nothing.
		for ( let i = n; i < this.count; i ++ ) {

			this.wA[ i ].set( 1, 0, 1, 0 );
			this.wB[ i ].set( 0, 0, 0, 0 );

		}

		this.components = raw.slice( 0, n );

	}

	/* --------------------------------------------------------------------
	   CPU mirror.

	   The shader displaces horizontally, so the surface height "at" (x, z) is
	   not simply Y(x, z) — we have to find the rest position p0 whose displaced
	   XZ lands on the query point. Three fixed-point iterations are plenty at
	   the steepness values this demo allows, and this runs once per frame for
	   the camera, so it is not on any hot path.
	   -------------------------------------------------------------------- */

	/**
	 * @returns {number} world-space surface height at (x, z), metres
	 */
	heightAt( x, z, time, waveHeight, choppy ) {

		let px = x;
		let pz = z;

		for ( let iter = 0; iter < 3; iter ++ ) {

			let dx = 0;
			let dz = 0;

			for ( let i = 0; i < this.active; i ++ ) {

				const a = this.wA[ i ];
				const b = this.wB[ i ];
				const s = Math.sin( a.z * ( a.x * px + a.y * pz ) - a.w * time + b.z );
				const H = b.y * choppy;
				dx -= H * a.x * s;
				dz -= H * a.y * s;

			}

			// Newton-free correction: push the rest position by the residual.
			px = x - dx;
			pz = z - dz;

		}

		let y = 0;

		for ( let i = 0; i < this.active; i ++ ) {

			const a = this.wA[ i ];
			const b = this.wB[ i ];
			y += b.x * waveHeight * Math.cos( a.z * ( a.x * px + a.y * pz ) - a.w * time + b.z );

		}

		this._sx = px;
		this._sz = pz;

		return y;

	}

}

/**
 * Build the TSL evaluator for a wave field.
 *
 * Returns a plain JS function (not a wrapped Fn) so the caller can destructure
 * several outputs — displacement, normal and Jacobian all come from the same
 * accumulator pass and re-running it per output would triple the cost.
 *
 * @param {WaveField} field
 * @param {object} env    environment uniforms
 * @param {object} opts
 * @param {boolean} opts.earlyOut  cull unresolvable components per vertex
 */
export function createWaveEvaluator( field, env, { earlyOut = true } = {} ) {

	const u = env.u;
	const { uWA, uWB } = field;
	const count = field.count;

	/**
	 * @param {Node<vec2>}  p0    rest position in wave space (world XZ)
	 * @param {Node<float>} dist  distance from the camera, for detail fade
	 */
	return function evaluate( p0, dist ) {

		const dispX = float( 0 ).toVar( 'wDispX' );
		const dispY = float( 0 ).toVar( 'wDispY' );
		const dispZ = float( 0 ).toVar( 'wDispZ' );

		const jxx = float( 0 ).toVar( 'wJxx' );
		const jzz = float( 0 ).toVar( 'wJzz' );
		const jxz = float( 0 ).toVar( 'wJxz' );

		const dYdx = float( 0 ).toVar( 'wDYdx' );
		const dYdz = float( 0 ).toVar( 'wDYdz' );

		Loop( count, ( { i } ) => {

			const a = uWA.element( i );
			const b = uWB.element( i );

			const fadeEnd = b.w;

			if ( earlyOut ) {

				// Components are sorted longest-first, so once one is beyond its
				// resolvable range every remaining component is too.
				If( dist.greaterThan( fadeEnd ), () => {

					Break();

				} );

			}

			// Fade over the last 45% of the range rather than popping.
			const fade = oneMinus( smoothstep( fadeEnd.mul( 0.55 ), fadeEnd, dist ) ).toVar();

			const dir = vec2( a.x, a.y );
			const k = a.z;
			const omega = a.w;

			const amp = b.x.mul( u.waveHeight ).mul( fade ).toVar();
			const horiz = b.y.mul( u.waveChoppy ).mul( fade ).toVar();

			const theta = k.mul( dot( dir, p0 ) ).sub( omega.mul( u.time ) ).add( b.z ).toVar();
			const sT = sin( theta ).toVar();
			const cT = cos( theta ).toVar();

			dispY.addAssign( amp.mul( cT ) );
			dispX.subAssign( horiz.mul( dir.x ).mul( sT ) );
			dispZ.subAssign( horiz.mul( dir.y ).mul( sT ) );

			// d/dp0 of the horizontal term -> compression tensor
			const hk = horiz.mul( k ).mul( cT ).toVar();
			jxx.addAssign( hk.mul( dir.x ).mul( dir.x ) );
			jzz.addAssign( hk.mul( dir.y ).mul( dir.y ) );
			jxz.addAssign( hk.mul( dir.x ).mul( dir.y ) );

			// d/dp0 of the vertical term -> slope
			const ak = amp.mul( k ).mul( sT ).toVar();
			dYdx.subAssign( ak.mul( dir.x ) );
			dYdz.subAssign( ak.mul( dir.y ) );

		} );

		const exx = oneMinus( jxx ).toVar();
		const ezz = oneMinus( jzz ).toVar();
		const exz = jxz.negate().toVar();

		// Tangents of the displaced surface, exact rather than finite-differenced.
		const tanX = vec3( exx, dYdx, exz );
		const tanZ = vec3( exz, dYdz, ezz );

		const normal = normalize( cross( tanZ, tanX ) );

		// 1 on flat water, falling toward 0 (and below) where the surface folds.
		const jacobian = exx.mul( ezz ).sub( exz.mul( exz ) );

		return {
			displacement: vec3( dispX, dispY, dispZ ),
			height: dispY,
			normal,
			jacobian,
			// Slope magnitude, useful as a secondary foam / roughness cue.
			slope: vec2( dYdx, dYdz ),
		};

	};

}

/**
 * Compression -> foam amount. Shared by the surface material and the foam
 * history pass so both agree on where foam is born.
 */
export const foamFromJacobian = /*@__PURE__*/ Fn( ( [ jacobian, slopeLen, threshold, sharpness ] ) => {

	// Folding term: 1 - J rises as the surface pinches at a crest.
	const fold = saturate( oneMinus( jacobian ) ).toVar();

	// Steep faces spray even where they are not folding yet.
	const steep = saturate( slopeLen.mul( 0.42 ) ).toVar();

	const raw = fold.mul( 0.8 ).add( fold.mul( steep ).mul( 0.9 ) ).add( steep.mul( steep ).mul( 0.22 ) );

	return saturate( smoothstep( threshold, threshold.add( float( 0.30 ).div( sharpness ) ), raw ) );

} );
