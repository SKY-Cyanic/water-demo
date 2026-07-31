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
// Note what is deliberately *not* here: caustics. An earlier version projected
// them in this pass, which needed the world position reconstructed from depth —
// and that reconstruction depends on clip-space and screen-UV conventions that
// differ between the WebGPU and WebGL backends. Worse, it was a duplicate: the
// seabed material already casts caustics in world space, correctly, and open
// water has no bottom for them to land on. Removing them from here deleted the
// bug and improved the result.
//
// The pass only runs while the camera is near or under the surface; above water
// the renderer draws straight to the canvas at no post cost at all.

import { RenderPipeline, Vector2 } from 'three/webgpu';
import {
	Fn, abs, exp, float, max, min, mix, mx_fractal_noise_float, oneMinus, pass, pow, rtt,
	saturate, screenUV, smoothstep, uniform, vec2, vec3, vec4,
} from 'three/tsl';

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

			// Slight desaturation toward the medium at the frame edges, standing in
			// for the wider scattering angle off-axis.
			const edge = pow( abs( screenUV.sub( 0.5 ) ).mul( 2.0 ).length(), 2.2 ).mul( 0.16 ).mul( factor );
			fogged.assign( mix( fogged, medium, saturate( edge ) ) );

			const result = mix( scene.rgb, fogged, factor ).toVar( 'uwResult' );

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
