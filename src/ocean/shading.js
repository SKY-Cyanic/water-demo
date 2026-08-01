// Shared TSL shading helpers: Fresnel, a GGX sun lobe, sub-vertex ripple
// normals, and procedural caustics. Kept in one place so the surface, the
// seabed and the underwater pass all agree.

import { Fn, abs, cos, dot, exp, float, max, min, mix, mx_fractal_noise_float, mx_fractal_noise_vec3, mx_worley_noise_float, normalize, oneMinus, pow, saturate, sin, smoothstep, vec2, vec3 } from 'three/tsl';

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
 * Two counter-drifting Worley fields. The bright web is drawn where the two
 * fields *agree* — a set of wandering curves through the plane, which is the
 * right topology for a caustic: light folded by the surface concentrates on
 * curves (the fold caustics), not on points.
 *
 * The previous version took `1 - min(w1, w2)`. Worley's F1 distance is zero at
 * a cell's centre and largest at its boundary, so inverting it peaks at the
 * centres, and raising that to the seventh power isolated them completely: the
 * result was round blobs on a hexagonal lattice, covering the whole lagoon
 * floor in what looked like bubble wrap. It is the exact opposite of the
 * intended figure, and the comment above it claimed filaments throughout.
 *
 * @param {Node<vec2>}  p      world XZ of the lit surface
 * @param {Node<float>} time
 * @returns {Node<float>} 0..~1 caustic intensity
 */
export const causticPattern = /*@__PURE__*/ Fn( ( [ p, time ] ) => {

	// Cells were 2.4 m across, which is a caustic the size of a dinner table.
	// On a bottom a few metres down the web is finer than a pace.
	const q = p.mul( 1.15 ).toVar();
	const t = time.mul( 0.42 ).toVar();

	const w1 = mx_worley_noise_float( q.add( vec2( t.mul( 0.21 ), t.mul( - 0.13 ) ) ), 1.0, 1 ).toVar();
	const w2 = mx_worley_noise_float(
		q.mul( 1.63 ).add( vec2( t.mul( - 0.16 ), t.mul( 0.24 ) ) ).add( 19.7 ), 1.0, 1
	).toVar();

	// Bright where the two fields cross. An exponential rather than a power
	// because the line width is then set directly, in units of the difference,
	// instead of emerging from an exponent that has to be re-guessed whenever
	// either field's scale moves.
	const c = exp( abs( w1.sub( w2 ) ).mul( - 13.0 ) ).mul( 2.2 )
		// A second, coarser crossing set. Real caustics are not one scale: the
		// long swell throws a broad slow web that the chop writes fine detail
		// onto, and their product is what makes the pattern look focused.
		.mul( exp( abs( w1.mul( 0.31 ).sub( w2.mul( 0.29 ) ) ).mul( - 5.0 ) ).mul( 0.55 ).add( 0.62 ) )
		.toVar();

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

/**
 * Bathymetry: metres of relief above the preset's nominal seabed depth.
 *
 * Shared, deliberately, by the seabed mesh and by the water surface's analytic
 * refraction. They are two renderings of one bottom, and if they disagree the
 * bottom visibly jumps as the camera crosses the waterline.
 *
 * Three scales. The sandbars are the important one: without them the bottom is
 * a plane at a single depth, the water column has a single thickness, and the
 * whole lagoon comes out one flat colour. Real shallow water is legible
 * precisely because depth varies — that is what draws the pale bars and the
 * dark channels between them.
 */
export const seabedHeight = /*@__PURE__*/ Fn( ( [ p ] ) => {

	// Roughly 300 m, 45 m and 8 m features. The middle scale is the one that
	// does the visible work: a viewer three metres up sees maybe forty metres of
	// bottom, so relief with a 300 m period is a constant across the frame and
	// relief with an 8 m period is texture. Only the 45 m band reads as terrain.
	const basin = mx_fractal_noise_float( vec3( p.mul( 0.0034 ), 0.0 ), 2, 2.0, 0.5 ).mul( 3.4 );
	const bars = mx_fractal_noise_float( vec3( p.mul( 0.022 ).add( 5.3 ), 0.0 ), 3, 2.0, 0.5 ).mul( 2.6 );
	const dunes = mx_fractal_noise_float( vec3( p.mul( 0.12 ), 0.0 ), 2, 2.0, 0.5 ).mul( 0.22 );

	return basin.add( bars ).add( dunes );

} );

/**
 * Bottom albedo: pale sand broken up by darker weed and reef patches.
 *
 * @param {Node<vec2>} p     world XZ
 * @param {Node<vec3>} sand  the preset's sand colour
 */
export const seabedAlbedo = /*@__PURE__*/ Fn( ( [ p, sand ] ) => {

	const grain = mx_fractal_noise_float( vec3( p.mul( 0.75 ), 0.0 ), 3, 2.0, 0.55 ).mul( 0.5 ).add( 0.5 );

	// Weed and reef. Uniform sand reads as a swimming-pool floor; the patches are
	// what make it a seabed, and their contrast against the sand is most of the
	// large-scale structure visible through the surface. It has to be strong —
	// several metres of water is a low-pass filter, and whatever contrast the
	// bottom does not have to begin with does not survive the column.
	const weed = smoothstep( 0.46, 0.72,
		mx_fractal_noise_float( vec3( p.mul( 0.030 ).add( 11.0 ), 0.0 ), 3, 2.0, 0.55 ).mul( 0.5 ).add( 0.5 )
	).toVar();

	// Wet sand reflects roughly a third of the light that reaches it, not most of
	// it. Authoring the preset colour at full brightness and then multiplying by
	// one meant a shallow bottom out-ran the water above it: the column had
	// nothing left to tint and the lagoon came out near-white.
	// Sand ripples. A lagoon floor under any swell at all is corrugated into
	// near-parallel bands about a third of a metre apart, and their direction
	// wanders slowly with the local flow. Without them the bottom is a noise
	// field, and a noise field several metres down low-passes into a smudge —
	// which is exactly how the reef read. Ripples survive the column because
	// they are *oriented*: the eye reconstructs a direction from far less
	// contrast than it needs to reconstruct a texture.
	const drift = mx_fractal_noise_float( vec3( p.mul( 0.014 ).add( 41.3 ), 0.0 ), 2, 2.0, 0.5 ).mul( 1.9 );
	const along = p.x.mul( cos( drift ) ).add( p.y.mul( sin( drift ) ) );
	const ripple = sin( along.mul( 19.0 ) ).mul( 0.5 ).add( 0.5 );

	// Crest-sharpened: a sand ripple has a rounded crest and a flat trough, so
	// the lit face is the narrower one.
	const corrugation = pow( ripple, 1.8 ).mul( 0.16 ).add( 0.92 );

	const base = sand.mul( float( 0.30 ).add( grain.mul( 0.22 ) ) ).mul( corrugation );

	// Weed does not grow in ripples, so it flattens them where it takes hold.
	return mix( base, sand.mul( 0.30 ).mul( vec3( 0.14, 0.24, 0.20 ) ), weed.mul( 0.92 ) );

} );

/**
 * Wave-group envelope.
 *
 * Mean 1.0, so multiplying a cascade by it leaves the significant wave height
 * the preset asked for intact while redistributing it into sets. Drifts at
 * roughly half the phase speed, which is the deep-water group velocity — sets
 * travel slower than the waves inside them.
 *
 * @param {Node<vec2>}  p       world XZ
 * @param {Node<float>} time
 * @param {Node<vec2>}  wind    unit wind direction
 * @param {Node<float>} amount  0 disables it exactly
 */
export const waveGroup = /*@__PURE__*/ Fn( ( [ p, time, wind, amount ] ) => {

	const q = p.mul( 0.0025 ).sub( wind.mul( time.mul( 0.4 ) ) ).toVar();
	const n = mx_fractal_noise_float( vec3( q, 0.0 ), 2, 2.0, 0.5 );

	return float( 1.0 ).add( n.mul( amount ) );

} );
