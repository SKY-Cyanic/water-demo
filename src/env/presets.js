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
			skyGradPower: 3.0, hazeColor: '#dff0f7', hazeStrength: 0.30, hazeFalloff: 34,
			sunGlowPower: 260, sunGlowStrength: 1.0, sunDiskSize: 1.0, starIntensity: 0,

			cloudCoverage: 0.22, cloudOpacity: 0.70, cloudScale: 1.40, cloudSpeed: 0.40,
			cloudLit: '#ffffff', cloudShadow: '#a9c2d4',

			fogColor: '#cfe7f2', fogDensity: 0.030, exposure: 1.0, rainAmount: 0.0,

			waveHeight: 0.30, waveChoppy: 0.42, windSpeed: 3.2, windAngle: 130,
			waveScale: 0.45, detailStrength: 0.85,

			waterDeep: '#042f66', waterShallow: '#3ac6cd', waterScatter: '#1fb4c6',
			waterClarity: 1.9, absorptionR: 0.44, absorptionG: 0.055, absorptionB: 0.022,
			roughness: 0.055, sssStrength: 0.7, reflectivity: 1.0,

			foamAmount: 0.22, foamThreshold: 0.70, foamPersistence: 0.45,
			foamSharpness: 1.2, foamColor: '#f2fbfd',

			uwTint: '#12a0a8', uwVisibility: 34, causticStrength: 0.95, particleDensity: 0.35,

			seabedEnabled: 1, seabedDepth: 6.5, seabedColor: '#ded9c6',
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

			fogColor: '#b9d0e2', fogDensity: 0.055, exposure: 1.0, rainAmount: 0.0,

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

			fogColor: '#f0b98a', fogDensity: 0.085, exposure: 1.05, rainAmount: 0.0,

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

			fogColor: '#78838f', fogDensity: 0.140, exposure: 1.15, rainAmount: 0.85,

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

			fogColor: '#182842', fogDensity: 0.060, exposure: 1.50, rainAmount: 0.0,

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

	{
		id: 'trade-winds',
		label: 'Trade Winds',
		swatch: '#0e5fa8',
		params: {
			// Deep tropical blue under a hard high sun: the water is clear enough
			// that almost nothing scatters back, so it goes dark and saturated
			// rather than milky, and every crest reads as a bright cut in it.
			sunElevation: 58, sunAzimuth: 100, sunIntensity: 1.30, sunColor: '#fff8ec',
			skyZenith: '#0d3d94', skyHorizon: '#9ec9ea', skyGround: '#2f5f74',
			skyGradPower: 3.4, hazeColor: '#cfe6f5', hazeStrength: 0.42, hazeFalloff: 30,
			sunGlowPower: 240, sunGlowStrength: 1.1, sunDiskSize: 1.0, starIntensity: 0,

			cloudCoverage: 0.34, cloudOpacity: 0.92, cloudScale: 1.30, cloudSpeed: 0.95,
			cloudLit: '#ffffff', cloudShadow: '#8fa8c4',

			fogColor: '#b9d6ec', fogDensity: 0.040, exposure: 1.0, rainAmount: 0.0,

			waveHeight: 1.55, waveChoppy: 0.86, windSpeed: 11.0, windAngle: 100,
			waveScale: 0.90, detailStrength: 1.15,

			waterDeep: '#01162e', waterShallow: '#0f6ea8', waterScatter: '#14839b',
			waterClarity: 1.35, absorptionR: 0.46, absorptionG: 0.085, absorptionB: 0.030,
			roughness: 0.070, sssStrength: 1.10, reflectivity: 1.0,

			foamAmount: 0.62, foamThreshold: 0.55, foamPersistence: 0.68,
			foamSharpness: 1.05, foamColor: '#f4fbff',

			uwTint: '#0a5a86', uwVisibility: 30, causticStrength: 0.55, particleDensity: 0.40,

			seabedEnabled: 0, seabedDepth: 40, seabedColor: '#7d7660',
		},
	},

	{
		id: 'coral-shallows',
		label: 'Coral Shallows',
		swatch: '#37d0b6',
		params: {
			// The shallowest preset. Three metres of water over sand and reef, so
			// the bottom is the subject and the surface is a lens over it.
			sunElevation: 47, sunAzimuth: 210, sunIntensity: 1.22, sunColor: '#fff4e2',
			skyZenith: '#2478c8', skyHorizon: '#c6e6f2', skyGround: '#4a7a80',
			skyGradPower: 2.8, hazeColor: '#e2f4fa', hazeStrength: 0.34, hazeFalloff: 30,
			sunGlowPower: 220, sunGlowStrength: 1.2, sunDiskSize: 1.0, starIntensity: 0,

			cloudCoverage: 0.30, cloudOpacity: 0.80, cloudScale: 1.55, cloudSpeed: 0.55,
			cloudLit: '#ffffff', cloudShadow: '#a8c6d6',

			fogColor: '#d6eef6', fogDensity: 0.028, exposure: 1.0, rainAmount: 0.0,

			waveHeight: 0.55, waveChoppy: 0.52, windSpeed: 4.6, windAngle: 210,
			waveScale: 0.50, detailStrength: 1.0,

			waterDeep: '#03518f', waterShallow: '#3fd8d2', waterScatter: '#22c2cf',
			waterClarity: 2.3, absorptionR: 0.48, absorptionG: 0.048, absorptionB: 0.018,
			roughness: 0.050, sssStrength: 0.85, reflectivity: 1.0,

			foamAmount: 0.28, foamThreshold: 0.66, foamPersistence: 0.50,
			foamSharpness: 1.15, foamColor: '#f6fdff',

			uwTint: '#15b0ac', uwVisibility: 42, causticStrength: 1.05, particleDensity: 0.25,

			seabedEnabled: 1, seabedDepth: 3.6, seabedColor: '#e9ece4',
		},
	},

	{
		id: 'arctic',
		label: 'Arctic',
		swatch: '#7e97a8',
		params: {
			// A low sun through thin overcast. Almost no colour anywhere, so what
			// carries the frame is the long specular sheet the low sun lays down
			// the middle of it.
			sunElevation: 9, sunAzimuth: 165, sunIntensity: 0.62, sunColor: '#e8eef6',
			skyZenith: '#4a6b88', skyHorizon: '#b9c8d4', skyGround: '#41525e',
			skyGradPower: 2.6, hazeColor: '#cbd8e2', hazeStrength: 0.72, hazeFalloff: 16,
			sunGlowPower: 70, sunGlowStrength: 1.05, sunDiskSize: 0.85, starIntensity: 0,

			cloudCoverage: 0.70, cloudOpacity: 0.95, cloudScale: 1.70, cloudSpeed: 0.65,
			cloudLit: '#dfe8f0', cloudShadow: '#7b8c9c',

			fogColor: '#c2d1dd', fogDensity: 0.090, exposure: 1.05, rainAmount: 0.0,

			waveHeight: 0.85, waveChoppy: 0.58, windSpeed: 5.5, windAngle: 165,
			waveScale: 1.10, detailStrength: 0.80,

			waterDeep: '#08151d', waterShallow: '#22505f', waterScatter: '#2c5f6b',
			waterClarity: 1.15, absorptionR: 0.44, absorptionG: 0.125, absorptionB: 0.080,
			roughness: 0.055, sssStrength: 0.35, reflectivity: 1.0,

			foamAmount: 0.34, foamThreshold: 0.62, foamPersistence: 0.80,
			foamSharpness: 1.0, foamColor: '#eaf1f7',

			uwTint: '#123542', uwVisibility: 16, causticStrength: 0.18, particleDensity: 0.70,

			seabedEnabled: 0, seabedDepth: 40, seabedColor: '#4e5560',
		},
	},

	{
		id: 'dusk',
		label: 'Dusk',
		swatch: '#6b6392',
		params: {
			// The blue hour: the sun is on the horizon, so there is no disc worth
			// speaking of and no glitter track — only a broad mauve wash the water
			// mirrors almost perfectly, because at this grazing angle Fresnel is
			// close to one everywhere.
			sunElevation: 0.6, sunAzimuth: 258, sunIntensity: 0.42, sunColor: '#ffb59a',
			skyZenith: '#1d2450', skyHorizon: '#c69ab0', skyGround: '#2c2b40',
			skyGradPower: 2.0, hazeColor: '#d3a9b8', hazeStrength: 0.62, hazeFalloff: 17,
			sunGlowPower: 55, sunGlowStrength: 1.9, sunDiskSize: 0.60, starIntensity: 0.30,

			cloudCoverage: 0.44, cloudOpacity: 0.88, cloudScale: 1.25, cloudSpeed: 0.55,
			cloudLit: '#e5b8b6', cloudShadow: '#4c4569',

			fogColor: '#a894ab', fogDensity: 0.070, exposure: 1.30, rainAmount: 0.0,

			waveHeight: 1.05, waveChoppy: 0.66, windSpeed: 6.5, windAngle: 258,
			waveScale: 1.05, detailStrength: 0.90,

			waterDeep: '#050a19', waterShallow: '#1c3b52', waterScatter: '#2a4666',
			waterClarity: 1.0, absorptionR: 0.44, absorptionG: 0.13, absorptionB: 0.075,
			roughness: 0.050, sssStrength: 0.80, reflectivity: 1.0,

			foamAmount: 0.42, foamThreshold: 0.60, foamPersistence: 0.74,
			foamSharpness: 1.0, foamColor: '#d9cdd6',

			uwTint: '#0d2438', uwVisibility: 13, causticStrength: 0.10, particleDensity: 0.55,

			seabedEnabled: 0, seabedDepth: 40, seabedColor: '#4a4450',
		},
	},

	{
		id: 'sea-fog',
		label: 'Sea Fog',
		swatch: '#96a09e',
		params: {
			// Visibility measured in tens of metres. Everything past the near swell
			// dissolves, which puts the whole burden of the shot on the foreground
			// water — and on the rain stippling the frame.
			sunElevation: 17, sunAzimuth: 320, sunIntensity: 0.34, sunColor: '#d8d6cf',
			skyZenith: '#5a6266', skyHorizon: '#9aa2a3', skyGround: '#4a5052',
			skyGradPower: 1.8, hazeColor: '#a6adae', hazeStrength: 0.94, hazeFalloff: 7,
			sunGlowPower: 26, sunGlowStrength: 0.60, sunDiskSize: 0.55, starIntensity: 0,

			cloudCoverage: 0.78, cloudOpacity: 0.85, cloudScale: 1.60, cloudSpeed: 1.10,
			cloudLit: '#9aa2a4', cloudShadow: '#5d6567',

			fogColor: '#a1a8a9', fogDensity: 2.100, exposure: 1.20, rainAmount: 0.55,

			waveHeight: 1.30, waveChoppy: 0.70, windSpeed: 7.0, windAngle: 320,
			waveScale: 1.30, detailStrength: 0.95,

			waterDeep: '#0a1416', waterShallow: '#28464a', waterScatter: '#33565a',
			waterClarity: 0.75, absorptionR: 0.48, absorptionG: 0.18, absorptionB: 0.115,
			roughness: 0.075, sssStrength: 0.45, reflectivity: 1.0,

			foamAmount: 0.52, foamThreshold: 0.56, foamPersistence: 0.82,
			foamSharpness: 0.95, foamColor: '#dfe4e4',

			uwTint: '#14282c', uwVisibility: 8, causticStrength: 0.08, particleDensity: 1.0,

			seabedEnabled: 0, seabedDepth: 40, seabedColor: '#454842',
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
