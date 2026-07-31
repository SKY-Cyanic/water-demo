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

import { Fn, abs, dot, exp, float, floor, fract, length, max, min, mix, mx_cell_noise_float, mx_fractal_noise_float, normalize, oneMinus, pow, saturate, screenUV, sin, smoothstep, step, texture, vec2, vec3 } from 'three/tsl';

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
	cloudTexture = null, cloudTexel = null,
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

		if ( cloudTexture ) {

			/* ------------------------------------------- volumetric clouds (RT)
			 *
			 * The slab march itself lives in createCloudMarchFn and runs in its own
			 * half-resolution pass; here we only composite its result. Marching at
			 * full resolution cost more than the entire ocean — a cloud is a
			 * low-frequency object and half the linear resolution is invisible on
			 * it, while a quarter of the pixels buys back enough budget to nearly
			 * triple the step count. Fewer, larger steps were what produced the
			 * dithering in the first place, so this is the same fix seen from the
			 * cost side.
			 *
			 * screenUV is the correct lookup because the cloud pass rasterises the
			 * same dome with the same camera: whatever convention screenUV follows,
			 * both passes follow it.
			 */
			// Four taps on a rotated grid, half a target-texel out. The bilinear
			// upsample alone leaves the jitter pattern visible as a fine chequer,
			// because that pattern lives at exactly the target's pixel frequency;
			// widening the kernel to a texel puts it below what the upsample can
			// carry. Three extra fetches on a quarter-resolution texture.
			const e = cloudTexel !== null ? cloudTexel : vec2( 0.0, 0.0 );
			const cl = texture( cloudTexture, screenUV ).mul( 0.4 )
				.add( texture( cloudTexture, screenUV.add( vec2( e.x.mul( 0.5 ), e.y.mul( 0.5 ) ) ) ).mul( 0.15 ) )
				.add( texture( cloudTexture, screenUV.add( vec2( e.x.mul( - 0.5 ), e.y.mul( 0.5 ) ) ) ).mul( 0.15 ) )
				.add( texture( cloudTexture, screenUV.add( vec2( e.x.mul( 0.5 ), e.y.mul( - 0.5 ) ) ) ).mul( 0.15 ) )
				.add( texture( cloudTexture, screenUV.add( vec2( e.x.mul( - 0.5 ), e.y.mul( - 0.5 ) ) ) ).mul( 0.15 ) )
				.toVar( 'cloudSample' );

			col.assign( col.mul( oneMinus( cl.a ) ).add( cl.rgb ) );

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
