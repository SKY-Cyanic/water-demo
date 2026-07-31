// Environment presets.
//
// A preset is not a colour filter — it is a complete environment state. Sun
// elevation and colour, sky gradient, cloud cover, haze, fog, exposure, wave
// height and steepness, wind, water absorption, foam behaviour and underwater
// visibility all move together, because in a real sea they are not independent.
// Storm Front is not Open Sea tinted grey: it has a different sun, a different
// sky, five-metre waves, three times the foam and a third of the visibility.
//
// Every value here is a uniform, so a transition never recompiles a shader and
// never stalls.

import { blendParams, snapshotParams } from './uniforms.js';
import { smoothstep } from '../core/util.js';

export const PRESETS = [

	{
		id: 'calm-lagoon',
		label: 'Calm Lagoon',
		swatch: '#45c8c0',
		params: {
			sunElevation: 62, sunAzimuth: 130, sunIntensity: 1.15, sunColor: '#fff6e8',
			skyZenith: '#1f6fd0', skyHorizon: '#b7dcf0', skyGround: '#3f6a78',
			skyGradPower: 3.0, hazeColor: '#dff0f7', hazeStrength: 0.42, hazeFalloff: 34,
			sunGlowPower: 260, sunGlowStrength: 1.0, sunDiskSize: 1.0, starIntensity: 0,

			cloudCoverage: 0.22, cloudOpacity: 0.70, cloudScale: 1.40, cloudSpeed: 0.40,
			cloudLit: '#ffffff', cloudShadow: '#a9c2d4',

			fogColor: '#cfe7f2', fogDensity: 0.030, exposure: 1.0,

			waveHeight: 0.30, waveChoppy: 0.42, windSpeed: 3.2, windAngle: 130,
			waveScale: 0.45, detailStrength: 0.85,

			waterDeep: '#04525e', waterShallow: '#2fb3ab', waterScatter: '#3fc9b4',
			waterClarity: 1.9, absorptionR: 0.36, absorptionG: 0.075, absorptionB: 0.035,
			roughness: 0.055, sssStrength: 0.7, reflectivity: 1.0,

			foamAmount: 0.22, foamThreshold: 0.70, foamPersistence: 0.45,
			foamSharpness: 1.2, foamColor: '#f2fbfd',

			uwTint: '#12a0a8', uwVisibility: 34, causticStrength: 1.25, particleDensity: 0.35,

			seabedEnabled: 1, seabedDepth: 7.5, seabedColor: '#d8c79a',
		},
	},

	{
		id: 'open-sea',
		label: 'Open Sea',
		swatch: '#14707e',
		params: {
			sunElevation: 34, sunAzimuth: 45, sunIntensity: 1.0, sunColor: '#fff1d8',
			skyZenith: '#23538f', skyHorizon: '#a7c9e2', skyGround: '#3a5768',
			skyGradPower: 3.2, hazeColor: '#cfe0ec', hazeStrength: 0.55, hazeFalloff: 26,
			sunGlowPower: 200, sunGlowStrength: 1.3, sunDiskSize: 1.0, starIntensity: 0,

			cloudCoverage: 0.40, cloudOpacity: 0.85, cloudScale: 1.15, cloudSpeed: 0.70,
			cloudLit: '#ffffff', cloudShadow: '#93a9bd',

			fogColor: '#b9d0e2', fogDensity: 0.055, exposure: 1.0,

			waveHeight: 1.80, waveChoppy: 0.80, windSpeed: 9.5, windAngle: 45,
			waveScale: 1.0, detailStrength: 1.0,

			waterDeep: '#03202e', waterShallow: '#14707e', waterScatter: '#1d8f88',
			waterClarity: 1.0, absorptionR: 0.42, absorptionG: 0.11, absorptionB: 0.055,
			roughness: 0.085, sssStrength: 1.0, reflectivity: 1.0,

			foamAmount: 0.72, foamThreshold: 0.55, foamPersistence: 0.70,
			foamSharpness: 1.0, foamColor: '#eef6fa',

			uwTint: '#0b5a6e', uwVisibility: 22, causticStrength: 0.60, particleDensity: 0.60,

			seabedEnabled: 0, seabedDepth: 40, seabedColor: '#6f6a55',
		},
	},

	{
		id: 'golden-hour',
		label: 'Golden Hour',
		swatch: '#ffb066',
		params: {
			sunElevation: 4.5, sunAzimuth: 285, sunIntensity: 1.35, sunColor: '#ffb066',
			skyZenith: '#2b4f86', skyHorizon: '#ffb37a', skyGround: '#4a3b3a',
			skyGradPower: 2.1, hazeColor: '#ffc79a', hazeStrength: 0.78, hazeFalloff: 15,
			sunGlowPower: 90, sunGlowStrength: 2.6, sunDiskSize: 1.15, starIntensity: 0,

			cloudCoverage: 0.46, cloudOpacity: 0.90, cloudScale: 1.00, cloudSpeed: 0.50,
			cloudLit: '#ffd9b0', cloudShadow: '#7d6472',

			fogColor: '#f0b98a', fogDensity: 0.085, exposure: 1.05,

			waveHeight: 1.35, waveChoppy: 0.72, windSpeed: 7.5, windAngle: 285,
			waveScale: 0.95, detailStrength: 1.0,

			waterDeep: '#08202c', waterShallow: '#1d6470', waterScatter: '#2d7e7a',
			waterClarity: 1.05, absorptionR: 0.44, absorptionG: 0.12, absorptionB: 0.060,
			roughness: 0.070, sssStrength: 1.6, reflectivity: 1.0,

			foamAmount: 0.55, foamThreshold: 0.58, foamPersistence: 0.72,
			foamSharpness: 1.0, foamColor: '#ffe6cf',

			uwTint: '#124d5e', uwVisibility: 18, causticStrength: 0.50, particleDensity: 0.55,

			seabedEnabled: 0, seabedDepth: 40, seabedColor: '#6b5a44',
		},
	},

	{
		id: 'storm-front',
		label: 'Storm Front',
		swatch: '#4a5a63',
		params: {
			sunElevation: 22, sunAzimuth: 200, sunIntensity: 0.42, sunColor: '#cfd7de',
			skyZenith: '#2b3641', skyHorizon: '#6b7683', skyGround: '#2a3138',
			skyGradPower: 2.4, hazeColor: '#7d8894', hazeStrength: 0.85, hazeFalloff: 12,
			sunGlowPower: 40, sunGlowStrength: 0.70, sunDiskSize: 0.70, starIntensity: 0,

			cloudCoverage: 0.86, cloudOpacity: 1.00, cloudScale: 0.85, cloudSpeed: 1.80,
			cloudLit: '#98a4b0', cloudShadow: '#3e4854',

			fogColor: '#78838f', fogDensity: 0.140, exposure: 1.15,

			waveHeight: 5.20, waveChoppy: 0.94, windSpeed: 21, windAngle: 200,
			waveScale: 1.25, detailStrength: 1.30,

			waterDeep: '#05161c', waterShallow: '#1b4a4a', waterScatter: '#2b5f57',
			waterClarity: 0.55, absorptionR: 0.50, absorptionG: 0.16, absorptionB: 0.090,
			roughness: 0.160, sssStrength: 0.70, reflectivity: 1.0,

			foamAmount: 1.00, foamThreshold: 0.38, foamPersistence: 0.90,
			foamSharpness: 0.85, foamColor: '#e6edf1',

			uwTint: '#143a40', uwVisibility: 9, causticStrength: 0.20, particleDensity: 1.0,

			seabedEnabled: 0, seabedDepth: 40, seabedColor: '#4d4a42',
		},
	},

	{
		id: 'moonlit',
		label: 'Moonlit',
		swatch: '#2b4a72',
		params: {
			// The "sun" here is the moon: same maths, ~1% of the intensity, cold
			// colour, and a much tighter glow because there is no daylight haze
			// to spread.
			sunElevation: 26, sunAzimuth: 315, sunIntensity: 0.10, sunColor: '#bcd2f5',
			skyZenith: '#050b1c', skyHorizon: '#1b2c4a', skyGround: '#060c14',
			skyGradPower: 2.6, hazeColor: '#24374f', hazeStrength: 0.50, hazeFalloff: 20,
			sunGlowPower: 700, sunGlowStrength: 1.60, sunDiskSize: 0.90, starIntensity: 1.0,

			cloudCoverage: 0.30, cloudOpacity: 0.75, cloudScale: 1.20, cloudSpeed: 0.50,
			cloudLit: '#7d8ea8', cloudShadow: '#202c3e',

			fogColor: '#182842', fogDensity: 0.060, exposure: 1.50,

			waveHeight: 1.15, waveChoppy: 0.70, windSpeed: 7.0, windAngle: 315,
			waveScale: 1.0, detailStrength: 1.0,

			waterDeep: '#01080f', waterShallow: '#0a2c3a', waterScatter: '#123f47',
			waterClarity: 0.90, absorptionR: 0.45, absorptionG: 0.13, absorptionB: 0.070,
			roughness: 0.060, sssStrength: 0.40, reflectivity: 1.0,

			foamAmount: 0.50, foamThreshold: 0.56, foamPersistence: 0.75,
			foamSharpness: 1.0, foamColor: '#c8d8ea',

			uwTint: '#06202e', uwVisibility: 14, causticStrength: 0.25, particleDensity: 0.50,

			seabedEnabled: 0, seabedDepth: 40, seabedColor: '#3a4050',
		},
	},

];

export const PRESET_BY_ID = Object.fromEntries( PRESETS.map( ( p ) => [ p.id, p ] ) );

export const DEFAULT_PRESET = 'open-sea';

/** Duration of a preset cross-fade, seconds. */
export const TRANSITION_SECONDS = 1.5;

/**
 * Drives preset cross-fades. Holds no uniforms of its own — it writes straight
 * into env.params, so a transition in progress and a user dragging a slider
 * both end up in the same place with no second source of truth.
 */
export class PresetMixer {

	constructor( env ) {

		this.env = env;
		this.current = null;
		this.t = 1;
		this._from = {};
		this._to = {};

	}

	/**
	 * @param {string} id
	 * @param {boolean} instant  skip the cross-fade (used on first load and by QA)
	 * @returns {boolean} whether the preset existed
	 */
	apply( id, instant = false ) {

		const preset = PRESET_BY_ID[ id ];
		if ( ! preset ) return false;

		this.current = id;

		if ( instant ) {

			Object.assign( this.env.params, preset.params );
			this.t = 1;

		} else {

			snapshotParams( this.env.params, this._from );
			snapshotParams( preset.params, this._to );
			this.t = 0;

		}

		this.env.dirty = true;
		return true;

	}

	get transitioning() {

		return this.t < 1;

	}

	update( dt ) {

		if ( this.t >= 1 ) return false;

		this.t = Math.min( 1, this.t + dt / TRANSITION_SECONDS );

		// Ease so the change starts and ends gently — a linear ramp reads as a
		// mechanical wipe, especially on the sun angle.
		blendParams( this.env.params, this._from, this._to, smoothstep( this.t ) );
		this.env.dirty = true;

		return true;

	}

}
