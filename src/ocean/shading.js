// Shared TSL shading helpers: Fresnel, a GGX sun lobe, sub-vertex ripple
// normals, and procedural caustics. Kept in one place so the surface, the
// seabed and the underwater pass all agree.

import { Fn, abs, cos, dot, exp, float, max, min, mix, mx_fractal_noise_vec3, mx_worley_noise_float, normalize, oneMinus, pow, saturate, sin, smoothstep, vec2, vec3 } from 'three/tsl';

/** Schlick's approximation. cosTheta is dot(N, V), clamped by the caller. */
export const fresnelSchlick = /*@__PURE__*/ Fn( ( [ cosTheta, f0 ] ) => {

	const m = saturate( oneMinus( cosTheta ) ).toVar();
	const m2 = m.mul( m );
	return f0.add( oneMinus( f0 ).mul( m2.mul( m2 ).mul( m ) ) );

} );

/**
 * Normalised GGX/Trowbridge-Reitz specular lobe for the sun.
 *
 * The sky reflection already carries the sun's broad glow, so this term exists
 * to supply the tight, bright specular the reflection lookup cannot resolve —
 * which is exactly what makes the glitter track down-sun read as sunlight
 * rather than as a white smear.
 */
export const ggxSpecular = /*@__PURE__*/ Fn( ( [ normal, viewDir, lightDir, roughness ] ) => {

	const h = normalize( viewDir.add( lightDir ) ).toVar();
	const nDotH = saturate( dot( normal, h ) ).toVar();

	const a = max( roughness.mul( roughness ), float( 0.0008 ) ).toVar();
	const a2 = a.mul( a ).toVar();

	const d = nDotH.mul( nDotH ).mul( a2.sub( 1.0 ) ).add( 1.0 ).toVar();

	return a2.div( float( Math.PI ).mul( d ).mul( d ).add( 1e-7 ) );

} );

/**
 * Sub-vertex ripple slope.
 *
 * The mesh can only carry waves it has vertices for; everything finer than that
 * lives here as a normal perturbation. Two decorrelated octave sets scroll with
 * the wind at different rates and fade out at different distances, so the fine
 * layer dies long before it can alias while the coarse layer survives out into
 * the mid-distance.
 *
 * @param {Node<vec2>}  p        world XZ
 * @param {Node<float>} time
 * @param {Node<vec2>}  wind     unit wind direction
 * @param {Node<float>} strength user detail multiplier
 * @param {Node<float>} dist     distance from camera
 * @returns {Node<vec2>} slope offset to add to the surface gradient
 */
export const rippleSlope = /*@__PURE__*/ Fn( ( [ p, time, wind, strength, dist ] ) => {

	const drift = wind.mul( time ).toVar();

	// Coarse ripples: ~5 m features, visible well into the distance.
	const fadeA = oneMinus( smoothstep( 400.0, 2600.0, dist ) ).toVar();
	const na = mx_fractal_noise_vec3(
		vec3( p.mul( 0.19 ).add( drift.mul( 0.08 ) ), time.mul( 0.09 ) ), 2, 2.0, 0.5
	).toVar();

	// Fine ripples: sub-metre. These are what make the sun track sparkle, so they
	// get a tight fade — past ~150 m a pixel covers many of them and keeping them
	// would only produce salt-and-pepper aliasing.
	const fadeB = oneMinus( smoothstep( 30.0, 400.0, dist ) ).toVar();
	const nb = mx_fractal_noise_vec3(
		vec3( p.mul( 0.92 ).add( drift.mul( 0.22 ) ).add( 41.3 ), time.mul( 0.28 ) ), 2, 2.0, 0.5
	).toVar();

	// Amplitudes are deliberately small. These are slope perturbations on top of
	// an already-correct analytic normal; pushed hard they stop reading as water
	// and start reading as crumpled foil.
	return na.xy.mul( fadeA.mul( 0.26 ) ).add( nb.xy.mul( fadeB.mul( 0.17 ) ) ).mul( strength );

} );

/**
 * Procedural caustics.
 *
 * Two counter-drifting Worley fields, inverted and sharpened, give the
 * characteristic bright interlocking web. Taking the min of the two produces
 * the ridge crossings where real caustics concentrate.
 *
 * @param {Node<vec2>}  p      world XZ of the lit surface
 * @param {Node<float>} time
 * @returns {Node<float>} 0..~1 caustic intensity
 */
export const causticPattern = /*@__PURE__*/ Fn( ( [ p, time ] ) => {

	const q = p.mul( 0.30 ).toVar();
	const t = time.mul( 0.42 ).toVar();

	const w1 = mx_worley_noise_float( q.add( vec2( t.mul( 0.21 ), t.mul( - 0.13 ) ) ), 1.0, 1 ).toVar();
	const w2 = mx_worley_noise_float(
		q.mul( 1.63 ).add( vec2( t.mul( - 0.16 ), t.mul( 0.24 ) ) ).add( 19.7 ), 1.0, 1
	).toVar();

	const ridge = oneMinus( min( w1, w2 ) ).toVar();

	// Sharpen into thin bright filaments rather than soft blobs.
	const c = pow( saturate( ridge ), 7.0 ).mul( 2.6 ).toVar();

	// A slow large-scale modulation so the web breathes instead of tiling flat.
	const breathe = sin( p.x.mul( 0.021 ).add( time.mul( 0.31 ) ) )
		.mul( cos( p.y.mul( 0.019 ).sub( time.mul( 0.24 ) ) ) )
		.mul( 0.22 ).add( 0.86 );

	return c.mul( breathe );

} );

/**
 * Bend a reflection vector that has dipped below the horizon back up to graze
 * it. Without this, a steep wave face reflects the "ground" hemisphere and
 * produces dark bruises on the water.
 */
export const liftReflection = /*@__PURE__*/ Fn( ( [ r ] ) => {

	const y = r.y.toVar();

	// Engage only once the ray has actually gone below the horizon, and remap it
	// gently. An earlier, wider version of this blend was active across the whole
	// near field, where the ripple-perturbed normal swings R.y back and forth
	// across the band every few pixels — the threshold then traced itself onto
	// the water as thin bright contour lines.
	const lifted = mix( y, abs( y ).mul( 0.16 ).add( 0.003 ), smoothstep( 0.0, - 0.055, y ) );
	return normalize( vec3( r.x, lifted, r.z ) );

} );

/** Beer-Lambert transmittance over `dist` metres with per-channel extinction. */
export const transmittance = /*@__PURE__*/ Fn( ( [ absorption, dist ] ) => {

	return exp( absorption.mul( max( dist, float( 0.0 ) ) ).negate() );

} );
