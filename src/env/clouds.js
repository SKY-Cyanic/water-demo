// Volumetric cloud layer.
//
// A raymarched slab of cumulus, rendered into its own half-resolution target
// once per frame and composited by the sky dome.
//
// Why a separate pass. Marching the slab per screen pixel is by far the most
// expensive thing in this scene — at 1080p it roughly doubled the frame time on
// its own. But a cloud is a low-frequency object: halving the linear resolution
// is invisible on it, and it cuts the work to a quarter. That budget goes
// straight back into step count, and step count is exactly what governs the
// dithering the jitter has to hide. Cheaper and cleaner at the same time.
//
// The pass rasterises the same dome sphere with the same camera as the main
// render, so the composite can look the result up by screenUV without any
// projection maths — and therefore without depending on clip-space or UV
// orientation conventions, which differ between the two backends.
//
// Output is premultiplied: rgb is scattered radiance already scaled by cover,
// a is cover. The dome then only has to do  sky*(1-a) + rgb.

import { BackSide, HalfFloatType, LinearFilter, Mesh, MeshBasicNodeMaterial, NoBlending, RenderTarget, Scene, SphereGeometry, Vector2 } from 'three/webgpu';
import {
	Break, Fn, If, Loop, dot, exp, float, fract, max, min, mix, mx_fractal_noise_float,
	normalize, oneMinus, positionLocal, pow, saturate, screenCoordinate, smoothstep, uniform,
	vec2, vec3, vec4,
} from 'three/tsl';

/** Cloud slab, metres above mean sea level. */
const BASE = 1400.0;
const TOP = 3100.0;
const THICK = TOP - BASE;

/**
 * Interleaved gradient noise (Jimenez), on *pixel* coordinates.
 *
 * This replaced the usual `fract(sin(dot(uv, k)) * 43758)` hash, which failed
 * here for two compounding reasons. Fed normalised screen UVs, the argument to
 * sin() reaches ~4e6 — where float32 carries about 0.25 of absolute precision,
 * so the "random" sequence collapses onto a lattice and the sky wore a visible
 * woven pattern. And even with the precision repaired, white noise is the wrong
 * dither for a one-sample-per-pixel march: the eye resolves it as grain. IGN is
 * low-discrepancy across every 3x3 neighbourhood, so adjacent pixels take
 * complementary offsets and the step structure averages out spatially.
 */
const interleavedGradientNoise = /*@__PURE__*/ Fn( ( [ p ] ) => {

	return fract( float( 52.9829189 ).mul(
		fract( p.x.mul( 0.06711056 ).add( p.y.mul( 0.00583715 ) ) )
	) );

} );

/**
 * Build the march.
 *
 * @param {object} env
 * @param {number} opts.cloudOctaves  total fBm octaves for the density field
 * @param {number} opts.marchSteps
 * @returns {Function} (dir) -> Node<vec4>  premultiplied (scatter, cover)
 */
export function createCloudMarchFn( env, { cloudOctaves = 5, marchSteps = 20 } = {} ) {

	const u = env.u;

	// Bounded contribution of the erosion octaves. Because it *is* bounded, a
	// sample whose base density sits further than this below the coverage
	// threshold cannot be lifted above it — so the detail octaves can be skipped
	// there exactly, not approximately.
	//
	// The value matters more than it looks. The base fBm is roughly normal about
	// 0.5 with a spread near 0.15, so a gain of 0.34 puts the skip threshold two
	// standard deviations out and virtually every sample takes the expensive
	// branch — the optimisation measured as noise. At 0.16 the branch fires on
	// about half of them, which is where the saving actually lives.
	const DETAIL_GAIN = 0.16;

	return Fn( ( [ dirIn ] ) => {

		const dir = normalize( vec3( dirIn ) ).toVar( 'cloudDir' );
		const h = dir.y.toVar( 'cloudH' );

		const scat = vec3( 0.0, 0.0, 0.0 ).toVar( 'cloudScatter' );
		const trans = float( 1.0 ).toVar( 'cloudTrans' );

		const sunUp = saturate( u.sunDir.y.mul( 6.0 ).add( 0.12 ) ).toVar( 'cloudSunUp' );

		If( h.greaterThan( 0.012 ), () => {

			const t0 = float( BASE ).div( h ).toVar( 'cloudT0' );
			// Near the horizon the slab is edge-on and the ray inside it is
			// enormous; clamping keeps the step size sane instead of letting every
			// sample land in a different cloud.
			const tEnd = min( float( TOP ).div( h ), t0.add( 4400.0 ) ).toVar( 'cloudT1' );
			const dt = tEnd.sub( t0 ).div( marchSteps ).toVar( 'cloudDt' );

			// Offset each ray's first sample by a fraction of a step. Without it
			// every ray samples the same planes and the slab renders as a stack of
			// hard shells — the step count drawn onto the sky.
			const jitter = interleavedGradientNoise( screenCoordinate.xy ).toVar( 'cloudJitter' );

			const thr = oneMinus( u.cloudCoverage ).toVar( 'cloudThr' );
			const scale = u.cloudScale.mul( 0.00042 ).toVar( 'cloudScaleV' );

			const densityAt = ( p, detail = true ) => {

				const hn = saturate( p.y.sub( BASE ).div( THICK ) );
				const q = vec3(
					p.x.mul( scale ).add( u.cloudDrift.x ),
					p.y.mul( scale ).mul( 0.7 ),
					p.z.mul( scale ).add( u.cloudDrift.y )
				);

				const n = mx_fractal_noise_float( q, 2, 2.0, 0.55 ).mul( 0.5 ).add( 0.5 ).toVar( 'cloudN' );

				if ( detail && cloudOctaves > 2 ) {

					If( n.greaterThan( thr.sub( DETAIL_GAIN ) ), () => {

						n.addAssign( mx_fractal_noise_float(
							q.mul( 4.0 ).add( 31.7 ), cloudOctaves - 2, 2.0, 0.55
						).mul( DETAIL_GAIN * 0.5 ) );

					} );

				}

				// Cumulus profile: rounded top, flat base. Deliberately gentle
				// ramps — a hard threshold turns every step into a visible shell.
				const prof = smoothstep( 0.0, 0.30, hn ).mul( oneMinus( smoothstep( 0.35, 1.0, hn ) ) );
				return saturate( n.sub( thr ).mul( 1.7 ) ).mul( prof );

			};

			Loop( marchSteps, ( { i } ) => {

				const t = t0.add( float( i ).add( jitter ).mul( dt ) );
				const p = dir.mul( t ).toVar( 'cloudP' );

				const dens = densityAt( p ).toVar( 'cloudDens' );

				If( dens.greaterThan( 0.006 ), () => {

					// Single-tap shadow ray, base octaves only. It only needs to know
					// roughly how much cloud lies between here and the sun.
					const l1 = densityAt( p.add( u.sunDir.mul( 420.0 ) ), false );
					const lightT = exp( l1.mul( - 1.35 ) ).toVar( 'cloudLightT' );

					// Henyey-Greenstein, forward scattering — this is what puts the
					// bright silver edge on a cloud in front of the sun.
					const cosL = dot( dir, u.sunDir );
					const g = float( 0.55 );
					const denom = float( 1.0 ).add( g.mul( g ) ).sub( g.mul( 2.0 ).mul( cosL ) );
					const phase = float( 1.0 ).sub( g.mul( g ) ).div( pow( max( denom, float( 1e-3 ) ), 1.5 ) ).mul( 0.28 );

					const lit = u.sunColor.mul( u.sunIntensity ).mul( lightT ).mul( phase.add( 0.22 ) )
						.add( u.cloudShadow.mul( 0.55 ) )
						.mul( mix( float( 0.28 ), float( 1.0 ), sunUp ) );

					const att = exp( dens.mul( dt ).mul( - 0.0042 ) ).toVar( 'cloudAtt' );
					scat.addAssign( lit.mul( trans ).mul( oneMinus( att ) ) );
					trans.mulAssign( att );

				} );

				If( trans.lessThan( 0.03 ), () => {

					Break();

				} );

			} );

		} );

		// Clouds fade out into the horizon haze like everything else.
		const cover = oneMinus( trans ).mul( u.cloudOpacity ).mul( smoothstep( 0.0, 0.10, h ) ).toVar( 'cloudCover' );

		return vec4( scat.mul( cover ), cover );

	} );

}

/**
 * Owns the half-resolution target and the dome that draws into it.
 */
export class CloudLayer {

	constructor( env, { cloudOctaves, marchSteps, scale = 0.5 } = {} ) {

		this.scale = scale;

		// One texel of the cloud target, in screen UV. The composite uses it to
		// widen its lookup into a tent, which is what finally removes the last of
		// the march's dither: at 0.4 scale a one-target-pixel pattern magnifies to
		// roughly 2.5 screen pixels, small enough to look like noise and large
		// enough to see.
		this.uTexel = uniform( new Vector2( 1 / 768, 1 / 432 ) );

		this.target = new RenderTarget( 2, 2, {
			// Scattered radiance is linear HDR and routinely exceeds 1, so an 8-bit
			// target would clip the sunlit tops to flat white before tone mapping
			// ever sees them.
			type: HalfFloatType,
			depthBuffer: false,
			stencilBuffer: false,
		} );
		this.target.texture.name = 'CloudLayer';
		this.target.texture.minFilter = LinearFilter;
		this.target.texture.magFilter = LinearFilter;
		this.target.texture.generateMipmaps = false;

		const material = new MeshBasicNodeMaterial();
		material.name = 'CloudMarch';
		material.side = BackSide;
		material.depthTest = false;
		material.depthWrite = false;
		material.fog = false;
		// Cover lives in alpha, and NodeMaterial forces alpha to 1 on an opaque
		// material — which silently turned every sky pixel into "fully covered by a
		// cloud that scatters no light", i.e. black. transparent:true keeps the
		// channel; NoBlending keeps the value literal rather than compositing it
		// against the cleared target.
		material.transparent = true;
		material.blending = NoBlending;
		material.colorNode = createCloudMarchFn( env, { cloudOctaves, marchSteps } )(
			normalize( positionLocal )
		);

		// The dome is centred on the camera, so its local position is the view
		// direction — the same trick the visible sky dome uses.
		this.mesh = new Mesh( new SphereGeometry( 4000, 48, 24 ), material );
		this.mesh.name = 'CloudDome';
		this.mesh.frustumCulled = false;
		this.mesh.matrixAutoUpdate = false;

		this.scene = new Scene();
		this.scene.add( this.mesh );

	}

	get texture() {

		return this.target.texture;

	}

	setSize( width, height ) {

		const w = Math.max( 2, Math.round( width * this.scale ) );
		const h = Math.max( 2, Math.round( height * this.scale ) );

		this.target.setSize( w, h );
		this.uTexel.value.set( 1 / w, 1 / h );

	}

	/** Draw the layer. Must run before the main scene render. */
	render( renderer, camera ) {

		this.mesh.position.copy( camera.position );
		this.mesh.updateMatrix();
		this.mesh.updateMatrixWorld( true );

		const previous = renderer.getRenderTarget();
		renderer.setRenderTarget( this.target );
		renderer.render( this.scene, camera );
		renderer.setRenderTarget( previous );

	}

	dispose() {

		this.mesh.geometry.dispose();
		this.mesh.material.dispose();
		this.target.dispose();

	}

}
