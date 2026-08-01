// Underwater rendering.
//
// A screen-space pass over the rendered scene, driven by per-pixel depth:
//
//   * Beer-Lambert extinction per colour channel over the view-ray distance.
//     Red dies within a couple of metres, blue-green carries; that single term
//     is most of why underwater footage looks the way it does.
//   * In-scattered light added back, saturating with distance, so far geometry
//     dissolves into the water colour rather than into black.
//   * A weak refractive wobble, driven by the same clock as the waves.
//   * Ambient light falling off with the viewer's own depth.
//
// Note what *is* here now: marched light shafts. An earlier version projected
// caustics in this pass and was removed because the seabed already casts them
// in world space and open water has no bottom for them to land on — both still
// true. Shafts are a different thing: they are the volume between the eye and
// the surface, which no surface material can draw. See the march below.
//
// The warning that came with removing them still stands and the shafts had to
// face it: reconstructing world position from depth depends on clip-space and
// screen-UV conventions that differ between the WebGPU and WebGL backends. The
// march below does reconstruct it, so `?forcewebgl=1` is part of its test.
//
// The pass only runs while the camera is near or under the surface; above water
// the renderer draws straight to the canvas at no post cost at all.

import { RenderPipeline, Vector2 } from 'three/webgpu';
import {
	Fn, If, abs, cameraProjectionMatrixInverse, cameraWorldMatrix, dot, exp, float, floor, fract,
	max, min, mix, mx_fractal_noise_float, normalize, oneMinus,
	pass, pow, rtt, saturate, screenSize, screenUV, sin, smoothstep, step, uniform,
	vec2, vec3, vec4,
} from 'three/tsl';

/** Raymarch steps for the light shafts. */
const SHAFT_STEPS = 6;

/**
 * The field a light shaft is cut from.
 *
 * Deliberately *not* `causticPattern`. Sharing that function was the obvious
 * thing to do — the shafts and the seabed should be lit by the same waves — but
 * it costs two Worley lookups per evaluation, and a march is many evaluations
 * per pixel. Fourteen steps of it put the underwater view at 14.7 fps.
 *
 * A shaft does not need cells. It needs a smooth field whose zero set is a
 * family of wandering curves, because that is the topology of a caustic fold,
 * and a ridged two-octave fBm gives exactly that for a fraction of the cost.
 * Eighteen-metre features, so the beams come out metres wide, which is what
 * they are.
 */
const shaftField = /*@__PURE__*/ Fn( ( [ p, time ] ) => {

	const n = mx_fractal_noise_float( vec3( p.mul( 0.055 ), time.mul( 0.16 ) ), 2, 2.0, 0.5 );
	return pow( oneMinus( abs( n ) ), 4.0 );

} );

export class UnderwaterPipeline {

	/**
	 * @param {object} opts
	 * @param {boolean} opts.bloom  add a bloom stage. When false and the camera is
	 *                              above water the app skips this pipeline entirely
	 *                              and draws straight to the canvas.
	 */
	constructor( renderer, scene, camera, env, opts = {} ) {

		this.renderer = renderer;
		this.env = env;
		this.hasBloom = opts.bloom === true;

		const u = env.u;

		this.scenePass = pass( scene, camera );

		const colorNode = this.scenePass.getTextureNode();
		const viewZ = this.scenePass.getViewZNode();

		// Camera depth below the mean surface, in metres. Drives how much light
		// is left to scatter.
		this.uCameraDepth = uniform( 0 );

		// Development aid: 0 normal · 1 raw scene colour · 2 view distance.
		// Reading a WebGPU canvas back with drawImage returns a stale frame, so
		// isolating a term by toggling objects and sampling pixels does not work —
		// rendering the term itself is the only reliable way to see it.
		this.uDebug = uniform( 0 );

		const output = Fn( () => {

			const factor = saturate( u.uwFactor ).toVar( 'uwFactor' );

			/* --- refractive wobble ------------------------------------- */

			// Small on purpose. Overdone, this reads as cheap heat haze.
			const wobble = mx_fractal_noise_float(
				vec3( screenUV.mul( vec2( 7.0, 4.0 ) ), u.time.mul( 0.35 ) ), 2, 2.0, 0.5
			).mul( 0.0035 ).mul( factor );

			const suv = screenUV.add( vec2( wobble, wobble.mul( 0.6 ) ) ).toVar( 'uwUV' );

			const scene = colorNode.sample( saturate( suv ) ).toVar( 'uwScene' );

			// viewZ is negative in front of the camera.
			const dist = max( viewZ.negate(), float( 0.0 ) ).toVar( 'uwDist' );

			/* --- extinction and in-scatter ----------------------------- */

			// The visibility slider is "how far you can see", so 1/visibility is
			// the extinction coefficient; the water's own absorption ratios tint it.
			const base = float( 1.0 ).div( max( u.uwVisibility, float( 1.0 ) ) ).toVar( 'uwExt' );
			const ext = u.absorption.div( max( u.absorption.g, float( 0.02 ) ) ).mul( base ).toVar( 'uwExtRGB' );

			const T = exp( ext.mul( min( dist, float( 4000.0 ) ) ).negate() ).toVar( 'uwT' );

			// Light available to scatter falls off with how deep the viewer is.
			const depthFade = exp( max( this.uCameraDepth, float( 0.0 ) ).mul( - 0.035 ) ).toVar( 'uwDepthFade' );
			const ambient = u.sunIntensity.mul( 0.65 ).add( 0.35 ).mul( depthFade ).toVar( 'uwAmbient' );

			const medium = u.uwTint.mul( ambient ).toVar( 'uwMedium' );

			const fogged = scene.rgb.mul( T ).add( medium.mul( oneMinus( T ) ) ).toVar( 'uwFogged' );

			/* --- orientation cues -------------------------------------- */

			// The brightest thing underwater is the surface overhead. Lifting the
			// top of frame keeps the viewer oriented instead of floating in soup.
			const upGlow = smoothstep( 0.40, 1.0, oneMinus( screenUV.y ) )
				.mul( depthFade ).mul( u.sunIntensity ).mul( 0.12 );
			fogged.addAssign( u.uwTint.mul( upGlow ) );

			/* --- light shafts ------------------------------------------ */

			// A light shaft is not a decorative streak: it is the caustic pattern on
			// the surface, extruded downward along the sun's direction and made
			// visible by the particles it scatters off. So it is marched, and it is
			// marched against the *same* caustic function the seabed is lit by —
			// which is the only way the shafts land where the bright patches on the
			// bottom are, and move with the same waves.
			//
			// The whole block is inside a branch on `uwFactor`, which is a uniform.
			// The branch is coherent across the draw and costs nothing above water,
			// where this pass is skipped outright anyway.
			//
			// `?noshafts=1` drops the march. There is no other way to attribute
			// frame time to it: two back-to-back runs of *this* file gave 38.6 fps
			// at eight steps and 31.9 at six, which is thermal drift swamping the
			// thing being measured. A switch that removes exactly one term, toggled
			// inside one session, is the only measurement that means anything.
			const wantShafts = new URLSearchParams( location.search ).get( 'noshafts' ) !== '1';

			If( factor.greaterThan( wantShafts ? 0.01 : 1e9 ), () => {

				// World-space view ray. The inverse projection gives a point on the
				// ray in view space; scaling it to z = -1 turns it into a direction
				// per unit of view depth, which is what `dist` is measured in.
				const ndc = vec3( screenUV.mul( 2.0 ).sub( 1.0 ), 0.0 ).toVar( 'uwNdc' );
				const h = cameraProjectionMatrixInverse.mul( vec4( ndc, 1.0 ) ).toVar( 'uwRayH' );
				const vRay = h.xyz.div( h.w ).toVar( 'uwRayView' );
				const vDir = vRay.div( max( vRay.z.negate(), float( 1e-4 ) ) ).toVar( 'uwRayDir' );

				const camW = cameraWorldMatrix.mul( vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz.toVar( 'uwCamW' );
				const farW = cameraWorldMatrix.mul( vec4( vDir.mul( 1.0 ), 1.0 ) ).xyz.toVar( 'uwFarW' );
				const rayW = normalize( farW.sub( camW ) ).toVar( 'uwRayW' );

				// The step is a *fixed* distance, and the scene depth occludes samples
				// rather than setting the step size.
				//
				// Scaling the step by `dist` was the first thing I tried and it does
				// not work at all: seen from below, the distance to the surface is
				// itself a radial function of screen position, so every sample landed
				// on a radially scaled coordinate and the whole frame came out as a
				// starburst converging on the camera's own axis. Any march whose step
				// is proportional to a screen-radial quantity has this failure, and it
				// looks like a rendering effect rather than like a bug, which is why
				// it is worth writing down.
				const span = min( u.uwVisibility, float( 55.0 ) ).toVar( 'uwSpan' );
				const step_ = span.div( SHAFT_STEPS ).toVar( 'uwStep' );

				// Six steps over fifty metres is nine-metre banding. Offsetting each
				// ray by a fraction of a step turns the bands into noise that the
				// neighbouring pixels average out — the same reason the cloud march
				// does it, and the same low-discrepancy sequence.
				const jitter = fract( float( 52.9829189 ).mul( fract(
					screenUV.x.mul( screenSize.x ).mul( 0.06711056 )
						.add( screenUV.y.mul( screenSize.y ).mul( 0.00583715 ) )
				) ) ).toVar( 'uwJitter' );

				const shaft = float( 0.0 ).toVar( 'uwShaft' );

				for ( let i = 0; i < SHAFT_STEPS; i ++ ) {

					const t = step_.mul( jitter.add( i ) ).toVar( `uwT${ i }` );
					const p = camW.add( rayW.mul( t ) ).toVar( `uwP${ i }` );

					// Nothing behind the first surface the scene pass recorded is in
					// the water any more. Faded over one step rather than cut: a hard
					// test makes the *number* of contributing samples a function of
					// scene depth, and scene depth seen from under a plane is smooth
					// and radial, so the cut traced its own contours across the frame.
					const visible = saturate( dist.sub( t ).div( step_ ) );

					// A sample that has left the water scatters nothing.
					//
					// Both terms below clamp the depth at zero, which meant every
					// above-surface sample got rise = 0 and down = 1 — the *maximum*
					// contribution — instead of none. The locus where the ray crosses
					// y = 0 therefore carried a crease, and since that locus passes
					// through the camera axis it drew a fold converging on the middle
					// of the frame in every underwater shot. The clamps are still
					// needed to keep the exponentials finite; what was missing is that
					// clamping a quantity is not the same as excluding the sample.
					const wet = saturate( p.y.negate().mul( 2.0 ) ).toVar( `uwWet${ i }` );

					// Walk from this sample up the sun's own direction to where it
					// pierces the mean surface. That intersection is where the water
					// focused the light that is passing through here.
					const rise = max( p.y.negate(), float( 0.0 ) )
						.div( max( u.sunDir.y, float( 0.12 ) ) );
					const surf = p.xz.add( u.sunDir.xz.mul( rise ) );

					// Attenuated twice: down from the surface to this depth, and back
					// along the view ray to the eye. Both are already one exponential
					// each, so this is the whole of it.
					const down = exp( max( p.y.negate(), float( 0.0 ) ).mul( - 0.055 ) );
					const back = exp( t.mul( ext.g ).negate() );

					shaft.addAssign(
						shaftField( surf, u.time )
							.mul( down ).mul( back ).mul( visible ).mul( wet )
					);

				}

				// Only the part of the sky's light that is still travelling in a beam
				// scatters into a visible shaft; a low sun spreads it out into general
				// murk. Divided by the step count so the brightness does not depend on
				// how finely the ray happened to be sampled.
				const beam = saturate( u.sunDir.y.mul( 2.2 ) ).mul( u.sunIntensity );

				// A beam is seen by the light it scatters sideways, so it is brightest
				// across the sun and nearly invisible looking straight down it.
				const across = oneMinus( abs( dot( rayW, u.sunDir ) ) ).toVar( 'uwAcross' );

				fogged.addAssign(
					u.uwTint.mul( u.sunColor ).mul(
						shaft.div( SHAFT_STEPS ).mul( beam ).mul( depthFade )
							.mul( across.mul( 0.7 ).add( 0.3 ) ).mul( 1.15 )
					)
				);

			} );

			// Slight desaturation toward the medium at the frame edges, standing in
			// for the wider scattering angle off-axis.
			const edge = pow( abs( screenUV.sub( 0.5 ) ).mul( 2.0 ).length(), 2.2 ).mul( 0.16 ).mul( factor );
			fogged.assign( mix( fogged, medium, saturate( edge ) ) );

			const result = mix( scene.rgb, fogged, factor ).toVar( 'uwResult' );

			/* --- rain --------------------------------------------------- */

			// Two layers of falling streaks, screen-space, above water only.
			//
			// A storm without rain is a colour grade. The streaks are what makes it
			// weather — and they are also the only element in the scene that moves
			// against the camera rather than with it, which is most of why they read
			// as being between the viewer and the sea.
			//
			// Aspect-corrected off screenSize so a wide window does not smear the
			// drops sideways; slanted by adding x into the vertical phase, which is
			// cheaper than rotating the lattice and indistinguishable at this size.
			const rain = float( 0.0 ).toVar( 'rainAcc' );

			// Uniform-driven, so the branch is coherent over the whole quad: eight
			// of the ten presets are dry and pay nothing for this.
			If( u.rainAmount.greaterThan( 0.001 ), () => {

			const aspect = screenSize.x.div( max( screenSize.y, float( 1.0 ) ) ).toVar( 'rainAspect' );

			for ( const [ density, speed, slant, weight ] of [ [ 44.0, 3.4, 0.26, 1.0 ], [ 76.0, 5.0, 0.30, 0.6 ] ] ) {

				// Shear x by the (time-advancing) y so the lattice itself leans: a
				// streak drawn vertically in this space comes out tilted on screen,
				// and because y carries the clock the whole curtain also drifts
				// sideways as it falls. Offsetting y by x instead — the obvious first
				// try — only reshuffles which cell a drop lands in and leaves every
				// streak bolt upright.
				const py = screenUV.y.mul( density * 0.34 ).add( u.time.mul( speed ) ).toVar();
				const p = vec2( screenUV.x.mul( aspect ).mul( density ).add( py.mul( slant ) ), py ).toVar();

				const cell = floor( p ).toVar();
				const f = fract( p ).toVar();

				// One drop per cell, present only in a sparse subset.
				const r = fract( sin( dot( cell, vec2( 41.13, 289.7 ) ) ).mul( 4193.77 ) ).toVar();

				const present = step( 0.79, r );
				const xoff = fract( r.mul( 17.3 ) ).sub( 0.5 ).mul( 0.7 );
				const streak = smoothstep( 0.5, 0.0, abs( f.x.sub( 0.5 ).sub( xoff ) ).mul( 26.0 ) )
					.mul( smoothstep( 1.0, 0.35, f.y ) );

				rain.addAssign( present.mul( streak ).mul( weight ) );

			}

			} );

			// Fades out under the surface, where falling water makes no sense.
			result.addAssign(
				vec3( 0.82, 0.86, 0.90 ).mul( saturate( rain ) ).mul( u.rainAmount ).mul( oneMinus( factor ) ).mul( 0.30 )
			);

			const dbg = this.uDebug;
			result.assign( mix( result, scene.rgb, dbg.equal( 1.0 ) ) );
			result.assign( mix( result, vec3( saturate( dist.div( 60.0 ) ) ), dbg.equal( 2.0 ) ) );

			return vec4( result, scene.a );

		} )();

		this.pipeline = new RenderPipeline( renderer, this.hasBloom ? this._addBloom( output ) : output );

	}

	/**
	 * Bloom.
	 *
	 * Sun glitter on water is the one thing in this scene that genuinely exceeds
	 * display range — individual wave facets reflect the solar disc directly. Tone
	 * mapping alone just clips them to white dots; the bleed into neighbouring
	 * pixels is what makes them read as *bright* rather than merely white.
	 *
	 * Three quarter-resolution passes: threshold, then a separable blur. Quarter
	 * res costs a sixteenth of the samples and is invisible at this blur radius.
	 */
	_addBloom( sourceNode ) {

		this.uBloomThreshold = uniform( 1.05 );
		this.uBloomStrength = uniform( 0.55 );
		this.uTexel = uniform( new Vector2( 1 / 960, 1 / 540 ) );

		// sourceNode is used directly rather than through a full-resolution render
		// target. The bright pass runs at quarter resolution, so inlining the
		// upstream graph there costs a sixteenth of what an extra full-res copy
		// would, and the final composite evaluates it exactly once either way.
		const source = sourceNode;

		const bright = Fn( () => {

			const c = source.rgb.toVar( 'bloomC' );
			const peak = max( c.r, max( c.g, c.b ) ).toVar( 'bloomPeak' );
			const excess = max( peak.sub( this.uBloomThreshold ), float( 0.0 ) );

			// Keep the hue of what was bright, scaled by how far past threshold it
			// went — a flat threshold on each channel would tint the glow.
			return vec4( c.mul( excess.div( max( peak, float( 1e-4 ) ) ) ), 1.0 );

		} )();

		const brightRT = rtt( bright );
		this.rtBright = brightRT;

		// 9-tap Gaussian, separable. Weights are the usual binomial approximation.
		const WEIGHTS = [ 0.227027, 0.194594, 0.121621, 0.054054, 0.016216 ];

		const blur = ( src, dirX, dirY ) => Fn( () => {

			const acc = src.sample( screenUV ).rgb.mul( WEIGHTS[ 0 ] ).toVar( 'blurAcc' );

			for ( let i = 1; i < WEIGHTS.length; i ++ ) {

				const off = vec2( this.uTexel.x.mul( dirX * i * 1.6 ), this.uTexel.y.mul( dirY * i * 1.6 ) );
				acc.addAssign( src.sample( saturate( screenUV.add( off ) ) ).rgb.mul( WEIGHTS[ i ] ) );
				acc.addAssign( src.sample( saturate( screenUV.sub( off ) ) ).rgb.mul( WEIGHTS[ i ] ) );

			}

			return vec4( acc, 1.0 );

		} )();

		const blurH = rtt( blur( brightRT, 1, 0 ) );
		const blurV = rtt( blur( blurH, 0, 1 ) );

		this.rtBlurH = blurH;
		this.rtBlurV = blurV;

		return Fn( () => {

			const base = source.toVar( 'bloomBase' );
			const glow = blurV.sample( screenUV ).rgb.mul( this.uBloomStrength );
			return vec4( base.rgb.add( glow ), base.a );

		} )();

	}

	/** Keep the bloom chain at quarter resolution as the window changes. */
	setSize( width, height ) {

		if ( ! this.hasBloom ) return;

		const w = Math.max( 2, Math.floor( width ) );
		const h = Math.max( 2, Math.floor( height ) );
		const qw = Math.max( 2, w >> 2 );
		const qh = Math.max( 2, h >> 2 );

		this.rtBright.setSize( qw, qh );
		this.rtBlurH.setSize( qw, qh );
		this.rtBlurV.setSize( qw, qh );

		this.uTexel.value.set( 1 / qw, 1 / qh );

	}

	/** @param {number} depth metres below the surface (0 when above) */
	setCameraDepth( depth ) {

		this.uCameraDepth.value = depth;

	}

	render() {

		this.pipeline.render();

	}

	dispose() {

		this.scenePass.dispose?.();

	}

}
