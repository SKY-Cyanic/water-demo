// Procedural sky.
//
// One TSL function, `skyColor(direction)`, is the single definition of what the
// atmosphere looks like. The sky dome renders it, and the water surface calls
// the very same function for its reflection lookup. That is why the reflected
// sun sits exactly where the real sun is and why a preset change moves both at
// once — there is no cubemap or HDRI to fall out of sync with.
//
// The model is an analytic approximation, not a physical solver:
//   - a horizon->zenith gradient standing in for Rayleigh extinction
//   - a wide forward-scattering lobe around the sun (Mie-ish)
//   - the solar disc itself
//   - a horizon haze band
//   - a thin procedural cloud sheet projected onto a flat plane
//   - optional stars for night presets

import { Break, Fn, If, Loop, abs, dot, exp, float, floor, fract, length, max, min, mix, mx_cell_noise_float, mx_fractal_noise_float, normalize, oneMinus, pow, saturate, screenUV, sin, smoothstep, step, vec2, vec3 } from 'three/tsl';

/**
 * Build a sky-sampling function.
 *
 * @param {object} env         environment uniforms from createEnv()
 * @param {object} opts
 * @param {number} opts.cloudOctaves  fBm octaves — the dome uses more than the
 *                                    water reflection, which is heavily minified
 *                                    and cannot resolve the fine detail anyway.
 * @param {boolean} opts.stars
 * @param {boolean} opts.sunDisk  Include the solar disc. Disabled for the water
 *                                reflection lookup, where a 0.5-degree disc
 *                                reflected off a rippling surface degenerates
 *                                into random white sparks. The surface gets an
 *                                analytic GGX lobe for the sun instead.
 * @returns {Function} (direction, blur = 0) -> Node<vec3> linear radiance
 *
 * `blur` (0..1) stands in for a pre-convolved environment map. A mirror
 * reflection samples the sky at a point; a rough one samples a whole cone of it.
 * Without this the water reflects a 5-degree-wide sun glow through a rippling
 * normal field and the glow's iso-surface draws itself onto the water as thin
 * bright filaments — the reflection equivalent of specular aliasing.
 */
export function createSkyFn( env, {
	cloudOctaves = 5, stars = true, sunDisk = true, clouds = true, sunLobe = true,
	volumetric = false, marchSteps = 16,
} = {} ) {

	const u = env.u;

	const fn = Fn( ( [ dirIn, blurIn ] ) => {

		const dir = normalize( vec3( dirIn ) ).toVar();
		const h = dir.y.toVar();
		const blur = saturate( float( blurIn ) ).toVar();

		// ---------------------------------------------------------- gradient
		// t = 1 at the horizon, falling to 0 at the zenith.
		const t = pow( saturate( float( 1 ).sub( saturate( h ) ) ), u.skyGradPower ).toVar();
		const col = mix( u.skyZenith, u.skyHorizon, t ).toVar();

		// Directions below the horizon still get sampled by the water's
		// reflection vector at grazing angles, so give them something sane
		// instead of letting the gradient run off.
		const below = smoothstep( 0.0, 0.10, h.negate() ).toVar();
		col.assign( mix( col, u.skyGround, below ) );

		// ------------------------------------------------------------- haze
		// A band hugging the horizon in both directions; this is what makes the
		// sea meet the sky softly instead of on a hard line.
		const haze = exp( abs( h ).mul( u.hazeFalloff ).negate() ).mul( u.hazeStrength ).toVar();
		col.assign( mix( col, u.hazeColor, saturate( haze ) ) );

		// -------------------------------------------------------------- sun
		const cosT = dot( dir, u.sunDir ).toVar();
		const sunUp = saturate( u.sunDir.y.mul( 6.0 ).add( 0.12 ) ).toVar();

		// Wide forward-scatter lobe. Two lobes at different tightness read much
		// more like real aerial haze than a single power term.
		//
		// The narrow lobe's exponent collapses with blur, which widens the glow
		// into the cone a rough surface actually integrates over. Its strength is
		// pulled back at the same time, since a wider lobe covers far more solid
		// angle for the same peak value.
		const glowPower = u.sunGlowPower.mul( pow( float( 0.014 ), blur ) ).toVar();

		// The water surface omits the narrow lobe. Both it and the analytic GGX
		// highlight represent the same sun, and drawing both meant the glitter
		// track was a broad dim wash that muddied into olive against the teal
		// water instead of a bright specular. The surface gets its sun from GGX
		// alone; the wide Mie halo stays, because that is genuine sky brightening.
		const glowNarrow = sunLobe
			? pow( saturate( cosT ), glowPower ).mul( mix( float( 1.0 ), float( 0.50 ), blur ) )
			: float( 0.0 );

		const glowWide = pow( saturate( cosT ), 8.0 ).mul( 0.16 );
		const glow = glowNarrow.add( glowWide ).mul( u.sunGlowStrength ).mul( u.sunIntensity );

		col.addAssign( u.sunColor.mul( glow ).mul( sunUp ) );

		if ( sunDisk ) {

			// Solar disc with a soft limb so it does not alias into a hard square.
			const disk = smoothstep( u.sunDiskCos.mul( 0.99992 ), u.sunDiskCos, cosT );
			col.addAssign( u.sunColor.mul( disk ).mul( u.sunIntensity ).mul( 22.0 ).mul( sunUp ) );

		}

		// ------------------------------------------------------------ stars
		if ( stars ) {

			// Cheap point field: quantise the direction into cells, keep a
			// sparse subset, and draw a soft dot at each surviving cell centre.
			const sp = dir.mul( 150.0 ).toVar();
			const cell = floor( sp ).toVar();
			const rnd = saturate( mx_cell_noise_float( cell ) ).toVar();
			const local = fract( sp ).sub( 0.5 ).toVar();
			const dotMask = smoothstep( 0.42, 0.0, length( local ).mul( mix( 2.4, 1.1, rnd ) ) );
			const present = step( 0.9825, rnd );
			// Fade out near the horizon and wherever the sky is already bright.
			const starFade = smoothstep( 0.02, 0.30, h ).mul( saturate( float( 1 ).sub( glow.mul( 3.0 ) ) ) );
			col.addAssign( vec3( 0.86, 0.91, 1.0 ).mul( present.mul( dotMask ).mul( starFade ).mul( u.starIntensity ) ) );

		}

		if ( ! clouds ) {

			col.assign( mix( col, u.hazeColor, saturate( haze.mul( 0.55 ) ) ) );
			return max( col, vec3( 0.0 ) );

		}

		if ( volumetric ) {

			/* ------------------------------------------------ volumetric clouds
			 *
			 * A flat noise sheet is cheap but it is unmistakably flat: it has no
			 * silhouette, no self-shadowing, and it slides rather than sitting in
			 * the sky. Marching an actual slab costs more but buys all three.
			 *
			 * Single-scattering only: transmittance toward the sun is estimated
			 * with two extra taps per lit sample, which is enough for the
			 * bright-rim / dark-base look that makes cumulus read as solid.
			 *
			 * Only the sky dome uses this. The water's reflection lookup keeps the
			 * flat sheet — it is heavily blurred by surface roughness anyway, and
			 * marching a volume per reflected pixel would cost more than the whole
			 * ocean.
			 */
			const BASE = 1500.0;
			const TOP = 4200.0;
			const THICK = TOP - BASE;

			const scat = vec3( 0.0, 0.0, 0.0 ).toVar( 'cloudScatter' );
			const trans = float( 1.0 ).toVar( 'cloudTrans' );

			If( h.greaterThan( 0.012 ), () => {

				const t0 = float( BASE ).div( h ).toVar( 'cloudT0' );
				// Near the horizon the slab is edge-on and the ray inside it is
				// enormous; clamping keeps the step size sane instead of letting
				// every sample land in a different cloud.
				const tEnd = min( float( TOP ).div( h ), t0.add( 9000.0 ) ).toVar( 'cloudT1' );
				const dt = tEnd.sub( t0 ).div( marchSteps ).toVar( 'cloudDt' );

				// Offset each pixel's first sample by a fraction of a step. Without
				// it, every ray samples the same planes and the slab renders as a
				// stack of hard shells — the march's step count drawn onto the sky.
				// Jittering converts that structured banding into high-frequency
				// noise, which at this density reads as softness instead.
				const jitter = fract( sin( dot( screenUV, vec2( 12.9898, 78.233 ) ).mul( 43758.5453 ) ) ).toVar( 'cloudJitter' );

				const thr = oneMinus( u.cloudCoverage ).toVar( 'cloudThr' );
				const scale = u.cloudScale.mul( 0.00042 ).toVar( 'cloudScale' );

				// Density at a world point. The shadow ray asks for fewer octaves:
				// it only needs to know roughly how much cloud is between here and
				// the sun, and detail there is invisible in the result while
				// costing as much as detail in the primary march.
				const densityAt = ( p, octaves = cloudOctaves ) => {

					const hn = saturate( p.y.sub( BASE ).div( THICK ) );
					const q = vec3(
						p.x.mul( scale ).add( u.cloudDrift.x ),
						p.y.mul( scale ).mul( 0.7 ),
						p.z.mul( scale ).add( u.cloudDrift.y )
					);
					const n = mx_fractal_noise_float( q, octaves, 2.0, 0.55 ).mul( 0.5 ).add( 0.5 );
					// Cumulus profile: rounded top, flat base. Deliberately gentle
					// ramps — a hard threshold turns every step into a visible shell.
					const prof = smoothstep( 0.0, 0.30, hn ).mul( oneMinus( smoothstep( 0.35, 1.0, hn ) ) );
					return saturate( n.sub( thr ).mul( 1.7 ) ).mul( prof );

				};

				Loop( marchSteps, ( { i } ) => {

					const t = t0.add( float( i ).add( jitter ).mul( dt ) );
					const p = dir.mul( t ).toVar( 'cloudP' );

					const dens = densityAt( p ).toVar( 'cloudDens' );

					If( dens.greaterThan( 0.003 ), () => {

						// Single-tap shadow ray, two octaves. Two taps looked no
						// different and cost as much again as the primary march.
						const l1 = densityAt( p.add( u.sunDir.mul( 420.0 ) ), 2 );
						const lightT = exp( l1.mul( - 1.35 ) ).toVar( 'cloudLightT' );

						// Henyey-Greenstein, forward scattering — this is what puts
						// the bright silver edge on a cloud in front of the sun.
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

			// Clouds fade into the horizon haze like everything else.
			const cover = oneMinus( trans ).mul( u.cloudOpacity ).mul( smoothstep( 0.0, 0.10, h ) ).toVar( 'cloudCover' );
			col.assign( col.mul( oneMinus( cover ) ).add( scat.mul( cover ) ) );

			col.assign( mix( col, u.hazeColor, saturate( haze.mul( 0.55 ) ) ) );

			return max( col, vec3( 0.0 ) );

		}

		// ----------------------------------------------------------- clouds
		// Project the view direction onto a flat sheet overhead. The +0.16 in
		// the denominator keeps the projection from exploding at the horizon,
		// which would otherwise alias badly.
		const cy = max( h, 0.0 ).add( 0.16 );
		const pp = dir.xz.div( cy ).mul( u.cloudScale ).add( u.cloudDrift ).toVar();

		// Two decorrelated fBm samples: one shapes the sheet, one erodes its
		// edges so the silhouette is not a single smooth threshold.
		const n1 = mx_fractal_noise_float( vec3( pp, u.time.mul( 0.012 ) ), cloudOctaves, 2.0, 0.55 );
		const n2 = mx_fractal_noise_float( vec3( pp.mul( 2.7 ).add( 31.7 ), u.time.mul( 0.02 ) ), 2, 2.0, 0.5 );
		const density = saturate( n1.mul( 0.5 ).add( 0.5 ).add( n2.mul( 0.14 ) ) ).toVar();

		// coverage = 0 -> threshold above every value -> clear sky.
		// Blur widens the coverage ramp, which is the cheap analogue of sampling
		// a lower environment mip: the silhouette softens instead of aliasing.
		const thresh = float( 1.0 ).sub( u.cloudCoverage ).toVar();
		const ramp = float( 0.20 ).add( blur.mul( 0.55 ) ).toVar();
		const cover = smoothstep( thresh.sub( ramp.mul( 0.35 ) ), thresh.add( ramp ), density ).toVar();

		// Thicker parts of the sheet sit in their own shadow; the sun side of
		// each puff picks up a warm rim from the forward-scatter lobe.
		const thick = saturate( density.sub( thresh ).mul( 3.0 ) );
		const cloudCol = mix( u.cloudLit, u.cloudShadow, thick ).toVar();
		cloudCol.addAssign( u.sunColor.mul( pow( saturate( cosT ), 5.0 ).mul( 0.5 ).mul( u.sunIntensity ) ) );
		cloudCol.mulAssign( mix( float( 0.30 ), float( 1.0 ), sunUp ) );

		// Fade the sheet out toward the horizon where it would be edge-on, and
		// let the haze swallow it.
		const cloudFade = smoothstep( 0.0, 0.16, h ).mul( u.cloudOpacity );
		col.assign( mix( col, cloudCol, saturate( cover.mul( cloudFade ) ) ) );

		// Distant clouds re-absorbed into the horizon haze.
		col.assign( mix( col, u.hazeColor, saturate( haze.mul( 0.55 ) ) ) );

		return max( col, vec3( 0.0 ) );

	} );

	// Callers that do not care about roughness can pass a direction alone.
	return ( dir, blur = float( 0 ) ) => fn( dir, blur );

}

/**
 * A cheaper variant for the water's reflection lookup: fewer cloud octaves and
 * no stars (they would alias violently across a rippling surface).
 */
export function createReflectionSkyFn( env ) {

	return createSkyFn( env, { cloudOctaves: 3, stars: false, sunDisk: false, sunLobe: false } );

}

/**
 * Cheapest variant — gradient, sun glow and haze only.
 *
 * Used for aerial perspective on the water surface. Because the sea meets the
 * sky by fading into *this exact function* sampled along the view ray, the
 * horizon line is continuous by construction rather than by tuning a fog colour
 * to match the sky by eye.
 */
export function createAerialSkyFn( env ) {

	return createSkyFn( env, { stars: false, sunDisk: false, clouds: false } );

}
