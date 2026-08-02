// Wave-crest spray.
//
// A breaking crest throws water off its face, and above a fresh breeze that
// airborne water is a large part of what the sea looks like. The demo had none:
// every whitecap was painted flat onto the surface, so the sea stayed a surface
// no matter how hard it was blowing. Its absence shows up more in motion than in
// a still, which is why the gap survived several rounds of screenshot review.
//
// No emitters and no readback. The usual construction finds breaking crests on
// the CPU and spawns particles at them, which needs the height field back from
// the GPU — and the whole point of the spectral path is that it never comes
// back. So it is built from the other end: a fixed lattice of particles anchored
// to world positions that follow the camera, each sampling the *same* folding
// metric the surface shader and the foam history use, at its own anchor, and
// showing itself only while the water under it is breaking. The sheet is then
// dense where the sea is breaking and empty where it is not, which is the
// behaviour wanted, without anything ever leaving the GPU.
//
// Each particle runs a sawtooth life on its own seed so the cloud does not pulse
// in unison, and within a life it follows a ballistic arc and drifts downwind.

import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, PointsNodeMaterial } from 'three/webgpu';
import {
	Fn, attribute, float, fract, length, max, mix, oneMinus, positionGeometry, pow, saturate,
	smoothstep, texture, uniform, uv, varyingProperty, vec2, vec3, vec4,
} from 'three/tsl';

import { foamFromJacobian } from '../ocean/waves.js';

/** How much each cascade's folding counts toward breaking. Same as material.js. */
const FOLD_WEIGHT = [ 1.0, 0.8, 0.15 ];

/** Wind speed below which a crest breaks without being torn into spray. */
const ONSET = 8.0;

/** Deterministic PRNG, so the lattice is identical between runs and backends. */
function mulberry32( a ) {

	return function () {

		a |= 0; a = a + 0x6D2B79F5 | 0;
		let t = Math.imul( a ^ a >>> 15, 1 | a );
		t = t + Math.imul( t ^ t >>> 7, 61 | t ) ^ t;
		return ( ( t ^ t >>> 14 ) >>> 0 ) / 4294967296;

	};

}

export class Spray {

	/**
	 * @param {object} env
	 * @param {object} spectral  cascade textures { disp, slope, sizes }
	 * @param {object} opts
	 * @param {number} opts.count   particles in the lattice
	 * @param {number} opts.extent  metres across the patch that follows the camera
	 */
	constructor( env, spectral, { count = 9000, extent = 220 } = {} ) {

		this.env = env;
		this.extent = extent;
		this.side = Math.ceil( Math.sqrt( count ) );

		const rnd = mulberry32( 20260802 );

		// Jittered lattice rather than pure noise. Uniform random placement clumps,
		// and a clump of spray reads as one blob instead of as a sheet.
		const positions = new Float32Array( count * 3 );
		const seeds = new Float32Array( count * 2 );

		for ( let i = 0; i < count; i ++ ) {

			const gx = ( i % this.side ) / this.side;
			const gz = Math.floor( i / this.side ) / this.side;

			positions[ i * 3 + 0 ] = ( gx + ( rnd() - 0.5 ) / this.side - 0.5 ) * extent;
			positions[ i * 3 + 1 ] = 0;
			positions[ i * 3 + 2 ] = ( gz + ( rnd() - 0.5 ) / this.side - 0.5 ) * extent;

			seeds[ i * 2 + 0 ] = rnd();   // life phase
			seeds[ i * 2 + 1 ] = rnd();   // launch speed and size variation

		}

		const geometry = new BufferGeometry();
		geometry.setAttribute( 'position', new BufferAttribute( positions, 3 ) );
		geometry.setAttribute( 'sseed', new BufferAttribute( seeds, 2 ) );

		const u = env.u;

		// World XZ of the patch centre. The mesh is moved here too, so the vertex
		// stage works in patch-local metres and never sees a large coordinate.
		this.uOrigin = uniform( vec2( 0, 0 ) );

		const material = new PointsNodeMaterial();
		material.name = 'Spray';
		material.transparent = true;
		material.depthWrite = false;
		material.blending = AdditiveBlending;
		material.sizeAttenuation = true;
		material.fog = false;

		const sampleAt = ( tex, worldXZ, size ) => texture( tex, worldXZ.div( size ), float( 0 ) );

		// Written by the vertex stage, read by both the size and colour stages.
		// Computing the crest test twice would be three more texture fetches per
		// particle for a value that cannot have changed in between.
		// Explicit varying properties, not `varying(expr)` wrappers: the crest test
		// has to be evaluated exactly once, inside the vertex scope. Same reason
		// material.js gives for the wave sum.
		const vLife = varyingProperty( 'float', 'vSprayLife' );
		const vBreak = varyingProperty( 'float', 'vSprayBreak' );

		material.positionNode = Fn( () => {

			const seed = attribute( 'sseed', 'vec2' ).toVar( 'spraySeed' );

			// Anchor: the lattice point in world space.
			const anchor = positionGeometry.xz.add( this.uOrigin ).toVar( 'sprayAnchor' );

			// The surface under the anchor, from the same cascades the water mesh
			// is displaced by, so the spray leaves the crest it belongs to instead
			// of hovering over the mean level.
			const disp = vec3( 0, 0, 0 ).toVar( 'sprayDisp' );
			const fold = float( 0 ).toVar( 'sprayFold' );
			const slope = vec2( 0, 0 ).toVar( 'spraySlope' );

			for ( let c = 0; c < spectral.sizes.length; c ++ ) {

				const d = sampleAt( spectral.disp[ c ], anchor, spectral.sizes[ c ] );
				const s = sampleAt( spectral.slope[ c ], anchor, spectral.sizes[ c ] );

				disp.addAssign( d.xyz );
				fold.addAssign( d.w.mul( FOLD_WEIGHT[ c ] ?? 0.15 ) );
				slope.addAssign( s.xy );

			}

			vBreak.assign( foamFromJacobian(
				fold.add( 1.0 ), length( slope ), u.foamThreshold, u.foamSharpness
			) );

			// Sawtooth life on the particle's own phase. Faster in a strong wind:
			// spray thrown harder is in the air for less time before it shreds.
			const rate = u.windSpeed.mul( 0.035 ).add( 0.55 ).toVar( 'sprayRate' );
			const life = fract( u.time.mul( rate ).add( seed.x.mul( 7.13 ) ) ).toVar( 'sprayLife' );
			vLife.assign( life );

			// Ballistic. Launch speed scales with the wind, which is what sets how
			// violently the crest is being torn off.
			const v0 = u.windSpeed.mul( 0.16 ).add( 0.8 ).mul( seed.y.mul( 0.7 ).add( 0.65 ) );
			const t = life.mul( 1.35 ).toVar( 'sprayT' );
			const rise = v0.mul( t ).sub( t.mul( t ).mul( 4.9 ) ).toVar( 'sprayRise' );

			// Downwind, and faster the higher it gets: air moves quicker clear of
			// the surface, and that shear is what tilts a spray plume forward.
			const carry = u.windDir.mul(
				u.windSpeed.mul( 0.30 ).mul( t ).mul( max( rise, float( 0.0 ) ).mul( 0.5 ).add( 0.7 ) )
			).toVar( 'sprayCarry' );

			// Back into patch-local metres, since the mesh sits at the origin.
			return vec3(
				positionGeometry.x.add( disp.x ).add( carry.x ),
				disp.y.add( max( rise, float( - 0.4 ) ) ),
				positionGeometry.z.add( disp.z ).add( carry.y )
			);

		} )();

		// Larger in a strong wind, and each droplet grows as its plume disperses.
		material.sizeNode = u.windSpeed.mul( 0.006 ).add( 0.05 ).mul( vLife.mul( 0.9 ).add( 0.7 ) );

		material.colorNode = Fn( () => {

			// Round, soft-edged sprite, the same shape as the underwater motes.
			const d = length( uv().sub( 0.5 ) ).toVar( 'sprayD' );
			const sprite = oneMinus( smoothstep( 0.10, 0.5, d ) ).toVar( 'spraySprite' );

			// In and out over the life so nothing pops, weighted to the start:
			// spray is brightest leaving the crest and thins as it disperses.
			const envelope = smoothstep( 0.0, 0.10, vLife )
				.mul( oneMinus( smoothstep( 0.35, 1.0, vLife ) ) );

			// Only where the water is breaking, and only above the wind that tears
			// a crest at all. Below the onset the sea should stay clean.
			const wind = smoothstep( ONSET, 20.0, u.windSpeed );
			const gate = pow( saturate( vBreak ), 1.6 ).mul( wind ).mul( u.foamAmount );

			// Lit like foam, because it is the same aerated water with air around it
			// instead of water. Off the sky rather than a constant, for the reason
			// foam is: at night a sheet of spray must not glow.
			const skyLight = mix( u.skyHorizon, u.skyZenith, 0.42 );
			const lit = u.foamColor.mul(
				skyLight.mul( 1.3 ).add( u.sunColor.mul( u.sunIntensity ).mul( 0.35 ) )
			);

			// Fade out over the last quarter of the patch. Two reasons, one of them
			// learned the hard way earlier in this project: it hides the boundary
			// where the lattice stops, and it removes the particles that have
			// shrunk under a pixel — an additive sub-pixel point is a guaranteed
			// sparkle, and sparkle is a tail statistic that no still frame shows.
			const r = length( positionGeometry.xz ).toVar( 'sprayR' );
			const edge = oneMinus( smoothstep( extent * 0.34, extent * 0.5, r ) );

			return vec4( lit, sprite.mul( envelope ).mul( gate ).mul( edge ).mul( 0.55 ) );

		} )();

		this.points = new Points( geometry, material );
		this.points.name = 'Spray';
		this.points.frustumCulled = false;
		this.points.visible = false;

	}

	/**
	 * Re-centre the patch on the viewer, snapped to the lattice pitch.
	 *
	 * Snapping matters for the same reason it does in the foam history: an
	 * unsnapped origin shifts every particle a fraction of a cell every frame, and
	 * a sheet of spray sliding against the water it is coming off reads as wrong
	 * immediately even though no single frame looks incorrect.
	 */
	update( camera ) {

		const p = this.env.params;

		this.points.visible = p.windSpeed > ONSET && p.foamAmount > 0.01;
		if ( ! this.points.visible ) return;

		const pitch = this.extent / this.side;
		const x = Math.round( camera.position.x / pitch ) * pitch;
		const z = Math.round( camera.position.z / pitch ) * pitch;

		this.uOrigin.value.set( x, z );
		this.points.position.set( x, 0, z );

	}

	dispose() {

		this.points.geometry.dispose();
		this.points.material.dispose();

	}

}
