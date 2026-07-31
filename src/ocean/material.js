// Water surface.
//
// The material is a MeshBasicNodeMaterial with a fully hand-written colorNode
// rather than MeshStandardNodeMaterial. Standard PBR has no vocabulary for the
// things that actually make water read as water — depth-dependent absorption,
// volume in-scattering, back-lit crests, Snell's window from below — and its
// lighting loop would be pure overhead here. Tone mapping and the output colour
// transform still come from the renderer, so this node returns linear HDR.
//
// Surface shading, in order:
//   1. wave normal (analytic, from the vertex pass) + sub-vertex ripple slope
//   2. Schlick Fresnel splits the result between reflection and transmission
//   3. reflection = the shared procedural sky, sampled along the bent view ray
//   4. transmission = Beer-Lambert bottom visibility + a depth-graded volume
//   5. an analytic GGX lobe for the sun (the reflection lookup omits the disc)
//   6. back-lit crest translucency
//   7. foam
//   8. aerial perspective into that same sky function -> seamless horizon

import { DoubleSide, FrontSide, Mesh, MeshBasicNodeMaterial } from 'three/webgpu';
import {
	Fn, If, abs, cameraPosition, dot, exp, faceDirection, float, length, max, min, mix,
	mx_fractal_noise_float, normalize, oneMinus, positionGeometry, positionWorld, pow, reflect,
	refract, saturate, screenUV, smoothstep, step, texture, varyingProperty, vec2, vec3,
} from 'three/tsl';

import { createWaveEvaluator, foamFromJacobian } from './waves.js';
import { causticPattern, fresnelSchlick, ggxSpecular, liftReflection, rippleSlope, seabedAlbedo, seabedHeight, transmittance } from './shading.js';

// Converts the GGX lobe (a density, in sr^-1) into the shader's radiance units.
// Calibrated so a near-mirror facet clips to white and a wind-roughened surface
// at glitter-track roughness peaks around 3 — i.e. bright enough for ACES to
// roll it to white without the surrounding water blowing out.
const SUN_SPEC_SCALE = 0.22;

/**
 * @param {object} env
 * @param {WaveField} field
 * @param {object} sky            { reflection, aerial } TSL sky functions
 * @param {object} opts
 * @param {object} opts.foam      optional foam history { texture, uvFor(worldXZ) }
 */
export function createOceanMaterial( env, field, sky, opts = {} ) {

	const u = env.u;
	const evaluate = createWaveEvaluator( field, env, { earlyOut: opts.earlyOut !== false } );

	const material = new MeshBasicNodeMaterial();
	material.name = 'OceanSurface';
	material.side = FrontSide;
	material.transparent = false;
	material.fog = false;

	/* ------------------------------------------------------------- vertex */

	// Declared up front, written in the vertex stage below, read in the fragment
	// stage. Explicit varying properties rather than varying(expr) wrappers,
	// because the wave sum has to be evaluated exactly once and inside a single
	// shader scope — see the note on positionNode.
	const vNormal = varyingProperty( 'vec3', 'vOceanNormal' );
	const vHeight = varyingProperty( 'float', 'vOceanHeight' );
	const vRadial = varyingProperty( 'float', 'vOceanRadial' );
	const vFoam = varyingProperty( 'float', 'vOceanFoam' );
	// Undisplaced world XZ. The foam history is indexed by the rest grid, so
	// sampling it with the displaced position would slide foam off its crest.
	const vRestXZ = varyingProperty( 'vec2', 'vOceanRestXZ' );

	// Spectral cascades, when the backend can run them. Sampled at an explicit
	// LOD: these textures carry no mipmaps and the vertex stage has no
	// derivatives, so an implicit lookup would be undefined there.
	const spectral = opts.spectral ?? null;
	const sampleAt = ( tex, worldXZ, size ) => texture( tex, worldXZ.div( size ), float( 0 ) );

	// The whole wave evaluation MUST be built inside an Fn body.
	//
	// TSL's Loop() and .toVar() attach themselves to the builder's *current
	// stack*. Constructed at module scope there is no stack to attach to: the
	// loop body silently never reaches the generated shader, every accumulator
	// stays at its initial zero, and the result is a mathematically perfect wave
	// field that displaces nothing and returns a constant up-normal.
	material.positionNode = Fn( () => {

		// positionGeometry is the raw attribute; positionLocal would be circular
		// here because NodeMaterial assigns positionNode straight into it.
		const restXZ = positionGeometry.xz;
		const radial = length( restXZ ).toVar( 'oceanRadial' );
		const restWorld = restXZ.add( u.oceanOrigin ).toVar( 'oceanRestWorld' );

		vRestXZ.assign( restWorld );
		vRadial.assign( radial );

		if ( spectral ) {

			const disp = vec3( 0, 0, 0 ).toVar( 'specDisp' );
			const slope = vec2( 0, 0 ).toVar( 'specSlope' );
			const divergence = float( 0 ).toVar( 'specDiv' );

			for ( let c = 0; c < spectral.sizes.length; c ++ ) {

				const [ f0, f1 ] = spectral.fade[ c ];
				const fade = oneMinus( smoothstep( f0, f1, radial ) ).toVar( `specFade${c}` );

				const d = sampleAt( spectral.disp[ c ], restWorld, spectral.sizes[ c ] );
				const s = sampleAt( spectral.slope[ c ], restWorld, spectral.sizes[ c ] );

				disp.addAssign( d.xyz.mul( fade ) );
				divergence.addAssign( d.w.mul( fade ) );
				slope.addAssign( s.xy.mul( fade ) );

			}

			vHeight.assign( disp.y );
			vNormal.assign( normalize( vec3( slope.x.negate(), 1.0, slope.y.negate() ) ) );

			// Jacobian ~= 1 + (dDx/dx + dDz/dz) for the displacement magnitudes
			// this surface reaches, so the divergence is the folding metric — the
			// same quantity the Gerstner path derives analytically.
			vFoam.assign( foamFromJacobian(
				divergence.add( 1.0 ), length( slope ), u.foamThreshold, u.foamSharpness
			) );

			return positionGeometry.add( disp );

		}

		const wave = evaluate( restWorld, radial );

		vNormal.assign( wave.normal );
		vHeight.assign( wave.height );
		vFoam.assign( foamFromJacobian(
			wave.jacobian, length( wave.slope ), u.foamThreshold, u.foamSharpness
		) );

		return positionGeometry.add( wave.displacement );

	} )();

	/* ----------------------------------------------------------- fragment */

	material.colorNode = Fn( () => {

		const P = positionWorld;
		const toEye = cameraPosition.sub( P ).toVar( 'toEye' );
		const viewDist = length( toEye ).toVar( 'viewDist' );
		const V = toEye.div( max( viewDist, float( 1e-4 ) ) ).toVar( 'V' );

		// under = 1 on back faces, i.e. the underside of the surface seen from
		// below the water.
		const under = oneMinus( saturate( faceDirection ) ).toVar( 'under' );

		/* --- normal ---------------------------------------------------- */

		const Nw = normalize( vNormal ).toVar( 'Nw' );

		// Work in gradient space so the ripple slope adds to the wave slope
		// correctly instead of being blended into a normalised vector.
		const invY = float( 1 ).div( max( Nw.y, float( 0.06 ) ) );
		const grad = vec2( Nw.x.mul( invY ), Nw.z.mul( invY ) ).toVar( 'grad' );

		if ( spectral ) {

			// Re-sample the cascades per pixel rather than relying on the
			// interpolated vertex normal. The mesh can only carry detail down to
			// its vertex spacing; the textures hold the real spectrum, so the
			// fragment stage gets waves the geometry never had.
			const g = vec2( 0, 0 ).toVar( 'specGradFrag' );

			for ( let c = 0; c < spectral.sizes.length; c ++ ) {

				const [ a, b ] = spectral.slopeFade[ c ];
				const fade = oneMinus( smoothstep( a, b, vRadial ) );
				g.addAssign( sampleAt( spectral.slope[ c ], vRestXZ, spectral.sizes[ c ] ).xy.mul( fade ) );

			}

			grad.assign( g.negate() );

			// A little procedural noise still helps below the finest cascade cell
			// (about 7 cm), where the spectrum simply has no data.
			grad.addAssign( rippleSlope( P.xz, u.time, u.windDir, u.detailStrength.mul( 0.30 ), vRadial ) );

		} else {

			grad.addAssign( rippleSlope( P.xz, u.time, u.windDir, u.detailStrength, vRadial ) );

		}

		const Nd = normalize( vec3( grad.x, 1.0, grad.y ) ).toVar( 'Nd' );

		// Far water must go flat or the normal aliases into a shimmering band
		// along the horizon.
		const flatten = smoothstep( 900.0, 9000.0, vRadial ).toVar( 'flatten' );
		const N = normalize( mix( Nd, vec3( 0.0, 1.0, 0.0 ), flatten ) ).toVar( 'N' );

		const nDotV = saturate( dot( N, V ) ).toVar( 'nDotV' );
		const nDotL = saturate( dot( N, u.sunDir ) ).toVar( 'nDotL' );

		const ambient = u.sunIntensity.mul( 0.7 ).add( 0.30 ).toVar( 'ambient' );

		// Diffuse skylight. The ocean is not lit by the sun alone — most of the
		// light leaving a wave trough is scattered skylight, and without this term
		// the troughs crush to black and the surface reads as polished metal.
		const skyLight = mix( u.skyHorizon, u.skyZenith, 0.42 ).toVar( 'skyLight' );

		/* --- reflection ------------------------------------------------ */

		const F = fresnelSchlick( nDotV, float( 0.02 ) ).mul( u.reflectivity ).toVar( 'F' );

		// Roughness blends from the material value near the camera, where the mesh
		// and ripple normals carry the slope distribution geometrically, to the
		// full wind-derived Cox-Munk value far away, where a pixel spans thousands
		// of unresolved ripples and the lobe has to represent them instead.
		//
		// This handoff is the sun's glitter track. Its width comes out of the wind
		// speed rather than a tuned constant, so raising the wind widens the track
		// the way it does on real water.
		const rough = mix(
			max( u.roughness, float( 0.020 ) ),
			u.slopeRoughness,
			smoothstep( 12.0, 520.0, vRadial )
		).toVar( 'rough' );

		// How much of the sky one pixel of this surface integrates over. Feeding
		// this to the sky function is a stand-in for a pre-convolved environment
		// map, and is what keeps the reflected sun glow from aliasing into
		// filaments across the ripple field.
		const reflBlur = saturate( rough.mul( 2.6 ).add( u.detailStrength.mul( 0.16 ) ) ).toVar( 'reflBlur' );

		const R = liftReflection( reflect( V.negate(), N ) ).toVar( 'R' );
		const reflection = sky.reflection( R, reflBlur ).toVar( 'reflection' );

		if ( opts.propReflection ) {

			// Mirrored props, sampled at this pixel's own screen position — see the
			// note in reflection.js for why that is exact for a plane at y = 0. The
			// offset by the surface gradient is what makes the reflection ripple
			// with the water instead of sitting on it like a decal; it is scaled
			// down with distance because a gradient that displaces by half a screen
			// near the camera displaces the horizon into nonsense.
			const wobble = grad.mul( oneMinus( smoothstep( 4.0, 90.0, vRadial ) ) ).mul( 0.055 );
			const rp = texture( opts.propReflection, saturate( screenUV.add( wobble ) ) ).toVar( 'propRefl' );

			reflection.assign( mix( reflection, rp.rgb, saturate( rp.a ).mul( u.vesselMix ) ) );

		}

		/* --- sun specular ---------------------------------------------- */

		// This lobe is now the *only* sun highlight on the water, so it carries the
		// whole glitter track. The clamp keeps a near-mirror surface from producing
		// single-pixel fireflies that no tone mapping can rescue.
		const specD = min( ggxSpecular( N, V, u.sunDir, rough ), float( 420.0 ) );
		const specular = u.sunColor
			.mul( specD.mul( F ).mul( nDotL ).mul( u.sunIntensity ).mul( SUN_SPEC_SCALE ) )
			.toVar( 'specular' );

		/* --- transmission ---------------------------------------------- */

		// Refract along a *smoothed* normal, not the full per-pixel one.
		//
		// Lateral displacement of the bottom scales with path length, so at eight
		// metres a ripple slope of 0.3 moves the sample two and a half metres. The
		// finest cascade and the procedural ripples both live below the size of the
		// reef patches, so shading with them scatters the bottom pattern inside a
		// single pixel and it averages back to flat colour — the lagoon comes out
		// blurred and its structure disappears.
		//
		// Reflection keeps the sharp normal, which is where that detail belongs:
		// the sky it samples is smooth, so fine slope shows up there as glitter
		// rather than as noise.
		const Nrefr = normalize( mix( N, Nw, float( 0.70 ) ) ).toVar( 'Nrefr' );
		const refr = refract( V.negate(), Nrefr, float( 0.7502 ) ).toVar( 'refr' );

		const maxPath = u.uwVisibility.mul( 1.6 ).toVar( 'maxPath' );

		// Distance down the refracted ray to the seabed. Clamped so a
		// near-horizontal ray cannot produce an enormous or negative path.
		//
		// Two steps: hit the nominal plane, then re-solve against the bathymetry
		// sampled at that first guess. One refinement is enough because the bottom
		// slopes gently compared with the ray, and it is what lets the sandbars
		// read as shallower water rather than as a flat plane with a texture on it.
		const descent = min( refr.y, float( - 0.02 ) );
		const solve = ( y ) => saturate( y.sub( P.y ).div( descent ).div( maxPath ) ).mul( maxPath );

		// Everything below costs about fourteen octaves of noise per pixel, and in
		// six of the ten presets there is no bottom at all. seabedMix is a uniform,
		// so the branch is coherent across the entire draw — it is free when off,
		// which is not true of anything keyed on per-pixel data.
		const bedY = float( 0.0 ).toVar( 'bedY' );
		const tBed = float( 0.0 ).toVar( 'tBed' );
		const bedColor = vec3( 0.0 ).toVar( 'bedColor' );

		If( u.seabedMix.greaterThan( 0.001 ), () => {

			const tFlat = solve( u.seabedY );
			bedY.assign( u.seabedY.add( seabedHeight( P.add( refr.mul( tFlat ) ).xz ) ) );
			tBed.assign( solve( bedY ) );

			// Vertical thickness of the water column over the bottom, which is what
			// governs how much sunlight reaches it — not the slanted view path.
			const waterDepth = max( P.y.sub( bedY ), float( 0.0 ) ).toVar( 'waterDepth' );

			const bedPoint = P.add( refr.mul( tBed ) );

			// Caustics wash out with depth: the focusing that makes them is destroyed
			// by the same scattering that limits visibility. Without this term they
			// were painted at full strength onto every depth, and a lagoon lit at noon
			// blew the whole frame to cream.
			const caustic = causticPattern( bedPoint.xz, u.time )
				.mul( u.causticStrength )
				.mul( exp( waterDepth.mul( - 0.11 ) ) )
				.mul( saturate( u.sunDir.y.mul( 2.0 ) ) )
				.toVar( 'caustic' );

			bedColor.assign( seabedAlbedo( bedPoint.xz, u.seabedColor )
				.mul( ambient )
				.mul( float( 1.0 ).add( min( caustic, float( 1.3 ) ).mul( 0.45 ) ) ) );

		} );

		const pathLen = mix( maxPath, tBed, u.seabedMix ).toVar( 'pathLen' );

		// Crests sit above the mean level, so there is less water between the
		// eye and whatever is below them — they read shallower.
		// Crests sit above the mean level and see more sky, so they read shallower.
		// The coupling is deliberately gentle: pushed hard, the long swell — which
		// dominates the height field — smears whole troughs into one dark blob.
		const crest = saturate( vHeight.mul( 0.40 ).add( 0.5 ) );

		// What counts as "deep" differs by two orders of magnitude between open
		// ocean and a lagoon. Over a bottom the interesting range is the first ~24
		// metres; normalising against the visibility distance instead put a
		// 7-metre lagoon at 0.15 of the gradient, so every part of it came out the
		// same pale shallow colour and the water read as a flat wash.
		const depthScale = mix( maxPath, float( 24.0 ), u.seabedMix ).toVar( 'depthScale' );
		const depthNorm = saturate( pathLen.div( depthScale ).mul( mix( float( 1.06 ), float( 0.68 ), crest ) ) ).toVar( 'depthNorm' );


		// Beer-Lambert: how much of the bottom survives the water column.
		const T = transmittance( u.absorption, pathLen ).mul( u.seabedMix ).toVar( 'T' );

		// Volume colour = the authored deep/shallow gradient under direct light,
		// plus upwelling scattered skylight. The second term is what ties the
		// water's colour to the sky, so a preset change moves both together.
		const volume = mix( u.waterShallow, u.waterDeep, depthNorm ).mul( ambient )
			.add( u.waterScatter.mul( skyLight ).mul( 0.80 ) )
			.toVar( 'volume' );

		const body = bedColor.mul( T ).add( volume.mul( oneMinus( T ) ) ).toVar( 'body' );

		/* --- contact with the vessel ----------------------------------- */

		// Normalised distance from the hull, in units of its own footprint: 0 at
		// the centreline, 1 at the planking. Cheap because the heading is baked
		// into the geometry, so the footprint is an axis-aligned ellipse.
		const hullD = float( 4.0 ).toVar( 'hullD' );
		const hullLocalOut = vec2( 0.0, 0.0 ).toVar( 'hullLocalOut' );

		If( u.vesselMix.greaterThan( 0.001 ), () => {

			// Rotate into the hull's own frame before normalising, so the footprint
			// is the ellipse the boat actually occupies rather than its bounding
			// box. At a 57-degree heading the box is nearly twice the area, and the
			// foam collar drawn from it read as a raft the boat was sitting on.
			// Offset opposite the sun by the hull's own height over the sun's
			// elevation — a shadow is cast, not centred. Clamped because a low sun
			// would otherwise throw it to the horizon.
			const drop = u.sunDir.xz.div( max( u.sunDir.y, float( 0.30 ) ) ).mul( 1.4 );
			const rel = P.xz.sub( u.vesselPos.xz ).add( drop ).toVar( 'hullRel' );

			// Rotate world XZ into the hull's frame: x across the beam, y toward the
			// bow. The transpose of this had the sign on the wrong term, which
			// rotates by -2h instead of -h — it maps correctly only when the heading
			// is zero, which is exactly the case anyone testing it would try first.
			// The footprint ellipse has been skewed off the hull since it was written.
			const c = u.vesselDir.x, sn = u.vesselDir.y;
			const hullLocal = vec2(
				rel.x.mul( c ).sub( rel.y.mul( sn ) ),
				rel.x.mul( sn ).add( rel.y.mul( c ) )
			).toVar( 'hullLocal' );

			hullD.assign( length( hullLocal.div( u.vesselHalf ) ) );
			hullLocalOut.assign( hullLocal );

			// The hull blocks the sky and the sun from the water under and beside
			// it. Without this the boat looks pasted on: it is the darkening in the
			// water, more than the object itself, that says something is *in* the
			// sea rather than in front of it.
			const shade = oneMinus( smoothstep( 0.72, 1.12, hullD ) ).mul( 0.34 ).toVar( 'hullShade' );
			body.mulAssign( oneMinus( shade ) );

		} );

		// Back-lit crest translucency: light entering the far side of a wave and
		// scattering out toward the eye. Strongest with a low sun behind the wave.
		const backLit = pow( saturate( dot( V, u.sunDir.negate() ) ), 3.5 );
		const thin = saturate( vHeight.mul( 0.55 ).add( 0.12 ) );
		const lowSun = saturate( oneMinus( u.sunDir.y.mul( 1.5 ) ) );
		const sss = backLit.mul( thin ).mul( lowSun ).mul( u.sssStrength ).toVar( 'sss' );
		body.addAssign( u.waterScatter.mul( u.sunColor ).mul( sss ).mul( 2.0 ).mul( u.sunIntensity ) );

		/* --- combine --------------------------------------------------- */

		const color = mix( body, reflection, F ).toVar( 'color' );
		color.addAssign( specular );

		/* --- foam ------------------------------------------------------ */

		// The crest mask says where foam *may* exist. On its own it traces the wave
		// contour, which reads as long painted ribbons. Two decorrelated noise
		// scales erode it: a coarse one that decides which stretches of crest are
		// foaming at all, and a fine one that tears the edges.
		const foamDrift = u.windDir.mul( u.time.mul( 0.42 ) );

		const foamFine = mx_fractal_noise_float(
			vec3( P.xz.mul( 0.44 ).add( foamDrift ), u.time.mul( 0.13 ) ), 3, 2.0, 0.55
		).mul( 0.5 ).add( 0.5 ).toVar( 'foamFine' );

		const foamPatch = mx_fractal_noise_float(
			vec3( P.xz.mul( 0.085 ).add( foamDrift.mul( 0.4 ) ).add( 7.1 ), u.time.mul( 0.045 ) ), 2, 2.0, 0.5
		).mul( 0.5 ).add( 0.5 ).toVar( 'foamPatch' );

		const foamRaw = vFoam.mul( u.foamAmount ).toVar( 'foamRaw' );

		// Waterline. A moored hull still works the water against its planking, and
		// the resulting collar of aerated foam is the one cue that reliably reads as
		// "floating in" rather than "resting on". Torn up by the same noise as
		// wave foam so it is not a drawn outline.
		If( u.vesselMix.greaterThan( 0.001 ), () => {

			const collar = smoothstep( 0.90, 1.00, hullD ).mul( oneMinus( smoothstep( 1.00, 1.14, hullD ) ) );

			// Torn by the same two noise scales as wave foam. A clean ring around
			// the hull is unmistakably a drawn outline; aeration is patchy.
			const torn = foamFine.mul( 0.55 ).add( foamPatch.mul( 0.45 ) ).add( 0.30 );

			/* --- wake ---------------------------------------------------- */

			// Metres astern of the transom, and metres off the track.
			const astern = max( hullLocalOut.y.negate().sub( u.vesselHalf.y.mul( 0.75 ) ), float( 0.0 ) ).toVar( 'wakeAstern' );
			const across = abs( hullLocalOut.x ).toVar( 'wakeAcross' );

			// The two Kelvin arms sit on a fixed half-angle from the track — about
			// 19.5 degrees for any displacement hull at any speed, which is why a
			// wake is recognisable at all. They are the shape; the centre trail is
			// just churn, so it spreads and fades much faster.
			const arm = exp( abs( across.sub( astern.mul( 0.354 ) ) ).mul( - 1.15 ) );
			const trail = exp( across.div( astern.mul( 0.16 ).add( 1.6 ) ).mul( - 1.5 ) );

			const decay = exp( astern.mul( - 0.021 ) ).mul( smoothstep( 0.0, 2.5, astern ) );
			const wake = arm.mul( 0.80 ).add( trail.mul( 0.55 ) ).mul( decay ).mul( u.vesselSpeed ).toVar( 'wake' );

			foamRaw.assign( max( foamRaw, collar.add( wake ).mul( torn ).mul( 1.45 ) ) );

		} );

		if ( opts.foam ) {

			// Foam laid down on earlier frames, decayed and drifted downwind. This
			// is what stops the sea from blinking: a crest that broke five seconds
			// ago still shows its trail.
			const history = opts.foam.sample( vRestXZ ).mul( u.foamAmount ).toVar( 'foamHistory' );
			foamRaw.assign( max( foamRaw, history ) );

		}

		// Distant foam is the worst aliasing source in the whole scene.
		const foamFade = oneMinus( smoothstep( 300.0, 1900.0, vRadial ) );

		const erode = foamFine.mul( 0.62 ).add( foamPatch.mul( 0.52 ) ).add( 0.14 ).toVar( 'foamErode' );
		const foamMask = smoothstep( 0.22, 0.70, foamRaw.mul( erode ) ).mul( foamFade ).toVar( 'foamMask' );

		// Foam is lit, not painted white: it darkens in shadow and warms at sunset.
		const foamLit = u.foamColor.mul(
			ambient.mul( 0.62 ).add( nDotL.mul( u.sunIntensity ).mul( 0.55 ) )
		);
		color.assign( mix( color, foamLit, foamMask ) );

		/* --- underside (seen from below the water) --------------------- */

		// Snell's window: the entire sky compresses into a ~97 degree cone
		// overhead; outside it the surface is a mirror for the water volume.
		const Ndown = N.negate();
		const through = refract( V.negate(), Ndown, float( 1.333 ) ).toVar( 'through' );
		const tir = step( length( through ), float( 0.5 ) ).toVar( 'tir' );

		const windowSky = sky.reflection( normalize( through.add( vec3( 0.0, 1e-5, 0.0 ) ) ), reflBlur );
		const volumeMirror = u.uwTint.mul( ambient ).mul( 0.55 );
		const fUnder = fresnelSchlick( saturate( dot( Ndown, V ) ), float( 0.02 ) );

		const underColor = mix( mix( windowSky, volumeMirror, tir ), volumeMirror, fUnder )
			.add( specular.mul( 0.35 ) );

		color.assign( mix( color, underColor, under ) );

		/* --- aerial perspective ---------------------------------------- */

		// Fade into the sky sampled along this pixel's own view direction. The
		// horizon is then continuous by construction — there is no fog colour to
		// hand-match against the sky.
		const aerial = sky.aerial( V.negate() ).toVar( 'aerial' );
		const fogT = oneMinus( transmittance( vec3( u.fogDensity.mul( 0.001 ) ), viewDist ).x );
		color.assign( mix( color, aerial, saturate( fogT ).mul( oneMinus( under ) ) ) );

		return max( color, vec3( 0.0 ) );

	} )();

	return material;

}

/**
 * Ocean mesh wrapper: owns the geometry, the material and the per-frame
 * re-centring on the camera.
 */
export class Ocean {

	constructor( env, field, geometryInfo, material ) {

		this.env = env;
		this.field = field;
		this.growth = geometryInfo.growth;
		this.triangles = geometryInfo.triangles;
		this.vertexCount = geometryInfo.vertexCount;

		this.mesh = new Mesh( geometryInfo.geometry, material );
		this.mesh.name = 'Ocean';
		// The mesh follows the camera and is displaced on the GPU, so no CPU-side
		// bound would be correct.
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = 0;
		this.mesh.matrixAutoUpdate = false;

	}

	/** Keep the disc centred under the camera and tell the shader where it is. */
	follow( camera ) {

		const x = camera.position.x;
		const z = camera.position.z;

		this.mesh.position.set( x, 0, z );
		this.mesh.updateMatrix();
		this.mesh.updateMatrixWorld( true );

		// Wave phase is sampled from world XZ, so the water stays put while the
		// mesh slides underneath the viewer.
		this.env.u.oceanOrigin.value.set( x, z );

	}

	/** Render the underside too, but only while it can actually be seen. */
	setUnderwater( active ) {

		const want = active ? DoubleSide : FrontSide;

		if ( this.mesh.material.side !== want ) {

			this.mesh.material.side = want;
			this.mesh.material.needsUpdate = true;

		}

	}

	dispose() {

		this.mesh.geometry.dispose();
		this.mesh.material.dispose();

	}

}
