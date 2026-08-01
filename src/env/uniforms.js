// Single source of truth for every tunable value in the demo.
//
//   env.params    plain JS values — what presets author, what the UI edits,
//                 what the preset interpolator blends.
//   env.u         TSL uniforms — what the shaders read.
//   syncUniforms  pushes params -> uniforms.
//
// Keeping the authored values flat and plain means the preset interpolator is a
// dozen lines with no reflection over nested shapes, and every shader parameter
// is live-editable without recompiling a node graph.

import { Color, Vector2, Vector3 } from 'three/webgpu';
import { uniform } from 'three/tsl';
import { DEG, hexToRgb, lerp, rgbToHex } from '../core/util.js';

/** Numeric parameters. Order here is the order the interpolator walks. */
export const SCALAR_KEYS = [
	// sun & sky
	'sunElevation', 'sunAzimuth', 'sunIntensity',
	'skyGradPower', 'hazeStrength', 'hazeFalloff',
	'sunGlowPower', 'sunGlowStrength', 'sunDiskSize', 'starIntensity',
	// clouds
	'cloudCoverage', 'cloudOpacity', 'cloudScale', 'cloudSpeed',
	// atmosphere
	'fogDensity', 'exposure', 'rainAmount',
	// waves
	'waveHeight', 'waveChoppy', 'windSpeed', 'windAngle', 'waveScale', 'detailStrength',
	// water optics
	'waterClarity', 'absorptionR', 'absorptionG', 'absorptionB',
	'roughness', 'sssStrength', 'reflectivity', 'varianceRough',
	'volumeGeom', 'scatterStrength',
	// foam
	'foamAmount', 'foamThreshold', 'foamPersistence', 'foamSharpness',
	// underwater
	'uwVisibility', 'causticStrength', 'particleDensity',
	'seabedDepth',
];

/** Colour parameters, authored as '#rrggbb' in sRGB. */
export const COLOR_KEYS = [
	'sunColor', 'skyZenith', 'skyHorizon', 'skyGround', 'hazeColor',
	'cloudLit', 'cloudShadow', 'fogColor',
	'waterDeep', 'waterShallow', 'waterScatter', 'foamColor',
	'uwTint', 'seabedColor',
];

/** Booleans / discrete values that never interpolate — they switch instantly. */
export const FLAG_KEYS = [ 'seabedEnabled' ];

export function createEnv() {

	const params = {

		/* --- sun & sky ------------------------------------------------- */
		sunElevation: 14,        // degrees above the horizon
		sunAzimuth: 40,          // degrees, 0 = +Z
		sunIntensity: 1.0,
		sunColor: '#fff2dd',
		skyZenith: '#2a63b4',
		skyHorizon: '#a8c8e0',
		skyGround: '#4a5f70',
		skyGradPower: 3.2,       // horizon->zenith falloff
		hazeColor: '#cfe0ec',
		hazeStrength: 0.55,
		hazeFalloff: 26.0,
		sunGlowPower: 220.0,
		sunGlowStrength: 1.4,
		sunDiskSize: 1.0,        // multiplier on the ~0.53 deg solar disc
		starIntensity: 0.0,

		/* --- clouds ---------------------------------------------------- */
		cloudCoverage: 0.42,
		cloudOpacity: 0.85,
		cloudScale: 1.15,
		cloudSpeed: 0.6,
		cloudLit: '#ffffff',
		cloudShadow: '#8ea2b6',

		/* --- atmosphere ------------------------------------------------ */
		fogColor: '#b9d0e2',
		fogDensity: 0.055,       // scaled internally; see material.js
		exposure: 1.0,

		/* --- waves ----------------------------------------------------- */
		waveHeight: 1.0,
		waveChoppy: 0.85,        // total Gerstner steepness budget
		windSpeed: 9.0,          // m/s — drives band amplitudes
		windAngle: 40,           // degrees
		waveScale: 1.0,          // global wavelength multiplier
		detailStrength: 1.0,     // fragment-side ripple normals

		/* --- water optics ---------------------------------------------- */
		waterDeep: '#04212e',
		waterShallow: '#1c7f86',
		waterScatter: '#2fa08c',
		waterClarity: 1.0,
		absorptionR: 0.42,       // Beer-Lambert extinction per metre, per channel
		absorptionG: 0.11,
		absorptionB: 0.055,
		roughness: 0.09,
		varianceRough: 1.0,
		volumeGeom: 1.0,
		scatterStrength: 0.085,
		sssStrength: 1.0,        // back-lit wave crest translucency
		reflectivity: 1.0,

		/* --- foam ------------------------------------------------------ */
		foamAmount: 0.75,
		foamThreshold: 0.52,
		foamPersistence: 0.72,
		foamSharpness: 1.0,
		foamColor: '#eef6fa',

		/* --- weather ---------------------------------------------------- */
		rainAmount: 0.0,

		/* --- underwater ------------------------------------------------ */
		uwTint: '#0d5566',
		uwVisibility: 26.0,      // metres
		causticStrength: 0.8,
		particleDensity: 0.6,

		/* --- seabed ---------------------------------------------------- */
		seabedEnabled: 0,
		seabedDepth: 16.0,
		seabedColor: '#b7a179',

	};

	const u = {

		time: uniform( 0 ),

		/* sun & sky */
		sunDir: uniform( new Vector3( 0, 0.24, 0.97 ) ),
		sunColor: uniform( new Color() ),
		sunIntensity: uniform( 1 ),
		skyZenith: uniform( new Color() ),
		skyHorizon: uniform( new Color() ),
		skyGround: uniform( new Color() ),
		skyGradPower: uniform( 3.2 ),
		hazeColor: uniform( new Color() ),
		hazeStrength: uniform( 0.55 ),
		hazeFalloff: uniform( 26 ),
		sunGlowPower: uniform( 220 ),
		sunGlowStrength: uniform( 1.4 ),
		sunDiskCos: uniform( 0.99996 ),
		starIntensity: uniform( 0 ),

		/* clouds */
		cloudCoverage: uniform( 0.42 ),
		cloudOpacity: uniform( 0.85 ),
		cloudScale: uniform( 1.15 ),
		cloudDrift: uniform( new Vector2() ),
		cloudLit: uniform( new Color() ),
		cloudShadow: uniform( new Color() ),

		/* atmosphere */
		fogColor: uniform( new Color() ),
		fogDensity: uniform( 0.055 ),

		/* waves */
		waveHeight: uniform( 1 ),
		waveChoppy: uniform( 0.85 ),
		waveScale: uniform( 1 ),
		waveSpeed: uniform( 1 ),
		windDir: uniform( new Vector2( 0, 1 ) ),
		windSpeed: uniform( 9 ),
		detailStrength: uniform( 1 ),
		// GGX roughness that reproduces the full sea-surface slope distribution,
		// derived from wind speed. See syncUniforms().
		slopeRoughness: uniform( 0.55 ),

		/* water optics */
		waterDeep: uniform( new Color() ),
		waterShallow: uniform( new Color() ),
		waterScatter: uniform( new Color() ),
		absorption: uniform( new Vector3() ),
		waterClarity: uniform( 1 ),
		roughness: uniform( 0.09 ),

		// Kill switch for the local slope-variance roughness term: 0 restores the
		// pure camera-distance ramp, which is what A/B measurement needs.
		varianceRough: uniform( 1 ),

		// Deep-water volume. volumeGeom is the kill switch — 0 restores the old
		// wave-height-only lerp exactly. backscatter is the water's b_b, which
		// together with absorption sets the single-scattering albedo.
		volumeGeom: uniform( 1 ),
		backscatter: uniform( new Vector3( 0.02, 0.05, 0.06 ) ),
		waveHs: uniform( 1.8 ),
		sssStrength: uniform( 1 ),
		reflectivity: uniform( 1 ),

		/* foam */
		foamAmount: uniform( 0.75 ),
		foamThreshold: uniform( 0.52 ),
		foamSharpness: uniform( 1 ),
		foamColor: uniform( new Color() ),

		/* weather */
		rainAmount: uniform( 0 ),

		/* hero vessel — where the water should show a waterline and a hull shadow */
		vesselPos: uniform( new Vector3() ),
		vesselHalf: uniform( new Vector2( 2.3, 7.6 ) ),   // half-beam, half-length
		vesselDir: uniform( new Vector2( 1, 0 ) ),        // (cos, sin) of the heading
		vesselMix: uniform( 0 ),                          // 0 when no vessel is present
		vesselSpeed: uniform( 0 ),                        // 0..1, how hard she is pushing a wake
		vesselHeel: uniform( 0 ),                         // lee heel, as a slope

		/* underwater */
		uwTint: uniform( new Color() ),
		uwVisibility: uniform( 26 ),
		uwFactor: uniform( 0 ),      // 0 = above water, 1 = fully submerged
		causticStrength: uniform( 0.8 ),

		/* seabed */
		seabedY: uniform( - 16 ),
		seabedMix: uniform( 0 ),     // 0 = open ocean, 1 = visible bottom
		seabedColor: uniform( new Color() ),

		/* camera-centred ocean origin, in wave-space metres */
		oceanOrigin: uniform( new Vector2() ),
		seabedOrigin: uniform( new Vector2() ),
		particleDensity: uniform( 0.6 ),

	};

	const env = {
		params,
		u,
		dirty: true,
		/** Cached sun direction in JS, kept in sync for CPU-side lighting maths. */
		sunDirJS: new Vector3( 0, 0.24, 0.97 ),
		windDirJS: new Vector2( 0, 1 ),
		_cloudDriftX: 0,
		_cloudDriftY: 0,
	};

	syncUniforms( env );

	return env;

}

function setColor( target, hex ) {

	// setHex with the default sRGB source converts into the renderer's linear
	// working space, so shader maths stays linear-light throughout.
	target.setHex( parseInt( hex.slice( 1 ), 16 ) );

}

/** Push `env.params` into `env.u`. Cheap enough to call whenever dirty. */
export function syncUniforms( env, dt = 0 ) {

	const p = env.params;
	const u = env.u;

	// --- sun direction from elevation/azimuth ---
	const el = p.sunElevation * DEG;
	const az = p.sunAzimuth * DEG;
	const ce = Math.cos( el );
	env.sunDirJS.set( ce * Math.sin( az ), Math.sin( el ), ce * Math.cos( az ) ).normalize();
	u.sunDir.value.copy( env.sunDirJS );

	setColor( u.sunColor.value, p.sunColor );
	u.sunIntensity.value = p.sunIntensity;

	setColor( u.skyZenith.value, p.skyZenith );
	setColor( u.skyHorizon.value, p.skyHorizon );
	setColor( u.skyGround.value, p.skyGround );
	u.skyGradPower.value = p.skyGradPower;

	setColor( u.hazeColor.value, p.hazeColor );
	u.hazeStrength.value = p.hazeStrength;
	u.hazeFalloff.value = p.hazeFalloff;

	u.sunGlowPower.value = p.sunGlowPower;
	u.sunGlowStrength.value = p.sunGlowStrength;
	// Solar disc: ~0.53 degrees across. Store cos(half-angle) so the shader
	// only needs a dot product.
	u.sunDiskCos.value = Math.cos( 0.00465 * Math.max( 0.2, p.sunDiskSize ) * 2.2 );
	u.starIntensity.value = p.starIntensity;

	u.cloudCoverage.value = p.cloudCoverage;
	u.cloudOpacity.value = p.cloudOpacity;
	u.cloudScale.value = p.cloudScale;
	setColor( u.cloudLit.value, p.cloudLit );
	setColor( u.cloudShadow.value, p.cloudShadow );

	setColor( u.fogColor.value, p.fogColor );
	u.fogDensity.value = p.fogDensity;

	u.waveHeight.value = p.waveHeight;
	u.waveChoppy.value = p.waveChoppy;
	u.waveScale.value = p.waveScale;
	u.windSpeed.value = p.windSpeed;
	u.detailStrength.value = p.detailStrength;

	// Cox & Munk's empirical sea-surface slope variance: sigma^2 = 0.003 + 0.00512*U
	// (U in m/s). This is the total mean-square slope of a wind-driven surface.
	//
	// Near the camera the mesh and the ripple normals reproduce that slope
	// distribution geometrically. Far away a single pixel spans thousands of
	// ripples and cannot, so the shader blends toward this value as the residual
	// roughness. That transition is what forms the sun's glitter track: the
	// highlight spreads from a sharp reflection into a broad shimmering band, at
	// a width set by the actual wind rather than by a hand-tuned constant.
	const slopeVariance = 0.003 + 0.00512 * Math.max( 0, p.windSpeed );
	// GGX alpha ~= sqrt(2) * slope sigma, and roughness = sqrt(alpha).
	u.slopeRoughness.value = Math.sqrt( Math.sqrt( 2 * slopeVariance ) );

	const wa = p.windAngle * DEG;
	env.windDirJS.set( Math.sin( wa ), Math.cos( wa ) );
	u.windDir.value.copy( env.windDirJS );

	setColor( u.waterDeep.value, p.waterDeep );
	setColor( u.waterShallow.value, p.waterShallow );
	setColor( u.waterScatter.value, p.waterScatter );
	// Higher clarity = less extinction.
	const inv = 1 / Math.max( 0.15, p.waterClarity );
	u.absorption.value.set( p.absorptionR * inv, p.absorptionG * inv, p.absorptionB * inv );
	u.waterClarity.value = p.waterClarity;
	u.roughness.value = p.roughness;
	u.varianceRough.value = p.varianceRough ?? 1;
	u.volumeGeom.value = p.volumeGeom ?? 1;
	u.waveHs.value = Math.max( 0.05, p.waveHeight );

	// Backscatter shares the scatter colour's chromaticity — they describe the
	// same particulate — scaled to a coefficient in inverse metres.
	{

		const c = u.waterScatter.value;
		const k = ( p.scatterStrength ?? 0.085 ) * inv;
		u.backscatter.value.set( Math.max( 1e-4, c.r * k ), Math.max( 1e-4, c.g * k ), Math.max( 1e-4, c.b * k ) );

	}
	u.sssStrength.value = p.sssStrength;
	u.reflectivity.value = p.reflectivity;

	u.foamAmount.value = p.foamAmount;
	// Whitecap coverage from wind speed (Monahan & O'Muircheartaigh 1980):
	// W = 3.84e-6 * U^3.41, the fraction of sea surface actively breaking. It is a
	// very steep law — 9.5 m/s gives ~0.8%, 21 m/s gives ~12% — and using it to
	// lower the fold threshold means coverage tracks the wind instead of being ten
	// hand-tuned preset numbers that all happened to sit above the onset.
	{

		const W = 3.84e-6 * Math.pow( Math.max( 0.5, p.windSpeed ), 3.41 );
		u.foamThreshold.value = p.foamThreshold * ( 1 - 0.55 * Math.min( 1, W / 0.02 ) );

	}
	u.foamSharpness.value = p.foamSharpness;
	setColor( u.foamColor.value, p.foamColor );

	u.rainAmount.value = p.rainAmount ?? 0;

	setColor( u.uwTint.value, p.uwTint );
	u.uwVisibility.value = p.uwVisibility;
	u.causticStrength.value = p.causticStrength;
	u.particleDensity.value = p.particleDensity;

	u.seabedY.value = - p.seabedDepth;
	u.seabedMix.value = p.seabedEnabled ? 1 : 0;
	setColor( u.seabedColor.value, p.seabedColor );

	// Clouds drift with the wind rather than on their own clock, so a wind
	// direction change reads as one coherent weather system.
	if ( dt > 0 ) {

		env._cloudDriftX += env.windDirJS.x * p.cloudSpeed * dt * 0.004;
		env._cloudDriftY += env.windDirJS.y * p.cloudSpeed * dt * 0.004;
		u.cloudDrift.value.set( env._cloudDriftX, env._cloudDriftY );

	}

}

/** Linear blend of two param sets into `out`. Flags snap at the midpoint. */
export function blendParams( out, a, b, t ) {

	for ( let i = 0; i < SCALAR_KEYS.length; i ++ ) {

		const k = SCALAR_KEYS[ i ];
		out[ k ] = lerp( a[ k ], b[ k ], t );

	}

	for ( let i = 0; i < COLOR_KEYS.length; i ++ ) {

		const k = COLOR_KEYS[ i ];
		const ca = hexToRgb( a[ k ] );
		const cb = hexToRgb( b[ k ] );
		out[ k ] = rgbToHex( [
			lerp( ca[ 0 ], cb[ 0 ], t ),
			lerp( ca[ 1 ], cb[ 1 ], t ),
			lerp( ca[ 2 ], cb[ 2 ], t ),
		] );

	}

	for ( let i = 0; i < FLAG_KEYS.length; i ++ ) {

		const k = FLAG_KEYS[ i ];
		out[ k ] = t < 0.5 ? a[ k ] : b[ k ];

	}

	return out;

}

/** Shallow copy of the interpolatable keys only. */
export function snapshotParams( p, out = {} ) {

	for ( let i = 0; i < SCALAR_KEYS.length; i ++ ) out[ SCALAR_KEYS[ i ] ] = p[ SCALAR_KEYS[ i ] ];
	for ( let i = 0; i < COLOR_KEYS.length; i ++ ) out[ COLOR_KEYS[ i ] ] = p[ COLOR_KEYS[ i ] ];
	for ( let i = 0; i < FLAG_KEYS.length; i ++ ) out[ FLAG_KEYS[ i ] ] = p[ FLAG_KEYS[ i ] ];
	return out;

}
