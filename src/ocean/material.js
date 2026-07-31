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
	Fn, cameraPosition, dot, faceDirection, float, length, max, min, mix, mx_fractal_noise_float,
	normalize, oneMinus, positionGeometry, positionWorld, pow, reflect, refract, saturate,
	smoothstep, step, texture, varyingProperty, vec2, vec3,
} from 'three/tsl';

import { createWaveEvaluator, foamFromJacobian } from './waves.js';
import { causticPattern, fresnelSchlick, ggxSpecular, liftReflection, rippleSlope, transmittance } from './shading.js';

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
		const flatten = smoothstep( 2600.0, 26000.0, vRadial ).toVar( 'flatten' );
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

		/* --- sun specular ---------------------------------------------- */

		// This lobe is now the *only* sun highlight on the water, so it carries the
		// whole glitter track. The clamp keeps a near-mirror surface from producing
		// single-pixel fireflies that no tone mapping can rescue.
		const specD = min( ggxSpecular( N, V, u.sunDir, rough ), float( 420.0 ) );
		const specular = u.sunColor
			.mul( specD.mul( F ).mul( nDotL ).mul( u.sunIntensity ).mul( SUN_SPEC_SCALE ) )
			.toVar( 'specular' );

		/* --- transmission ---------------------------------------------- */

		const refr = refract( V.negate(), N, float( 0.7502 ) ).toVar( 'refr' );

		const maxPath = u.uwVisibility.mul( 1.6 ).toVar( 'maxPath' );

		// Distance down the refracted ray to the seabed plane. Clamped so a
		// near-horizontal ray cannot produce an enormous or negative path.
		const descent = min( refr.y, float( - 0.02 ) );
		const tBed = saturate( u.seabedY.sub( P.y ).div( descent ).div( maxPath ) ).mul( maxPath ).toVar( 'tBed' );

		const pathLen = mix( maxPath, tBed, u.seabedMix ).toVar( 'pathLen' );

		// Crests sit above the mean level, so there is less water between the
		// eye and whatever is below them — they read shallower.
		// Crests sit above the mean level and see more sky, so they read shallower.
		// The coupling is deliberately gentle: pushed hard, the long swell — which
		// dominates the height field — smears whole troughs into one dark blob.
		const crest = saturate( vHeight.mul( 0.40 ).add( 0.5 ) );
		const depthNorm = saturate( pathLen.div( maxPath ).mul( mix( float( 1.06 ), float( 0.68 ), crest ) ) ).toVar( 'depthNorm' );

		// Seabed: procedural sand with caustics projected onto it.
		const bedPoint = P.add( refr.mul( tBed ) );
		const caustic = causticPattern( bedPoint.xz, u.time ).mul( u.causticStrength ).toVar( 'caustic' );
		const sandGrain = mx_fractal_noise_float( vec3( bedPoint.xz.mul( 0.22 ), 0.0 ), 3, 2.0, 0.5 ).mul( 0.13 );
		const bedColor = u.seabedColor.mul( ambient ).mul( float( 0.62 ).add( sandGrain ).add( caustic.mul( 0.85 ) ) );

		// Beer-Lambert: how much of the bottom survives the water column.
		const T = transmittance( u.absorption, pathLen ).mul( u.seabedMix ).toVar( 'T' );

		// Volume colour = the authored deep/shallow gradient under direct light,
		// plus upwelling scattered skylight. The second term is what ties the
		// water's colour to the sky, so a preset change moves both together.
		const volume = mix( u.waterShallow, u.waterDeep, depthNorm ).mul( ambient )
			.add( u.waterScatter.mul( skyLight ).mul( 0.80 ) )
			.toVar( 'volume' );

		const body = bedColor.mul( T ).add( volume.mul( oneMinus( T ) ) ).toVar( 'body' );

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

		if ( opts.foam ) {

			// Foam laid down on earlier frames, decayed and drifted downwind. This
			// is what stops the sea from blinking: a crest that broke five seconds
			// ago still shows its trail.
			const history = opts.foam.sample( vRestXZ ).mul( u.foamAmount ).toVar( 'foamHistory' );
			foamRaw.assign( max( foamRaw, history ) );

		}

		// Distant foam is the worst aliasing source in the whole scene.
		const foamFade = oneMinus( smoothstep( 380.0, 3600.0, vRadial ) );

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
