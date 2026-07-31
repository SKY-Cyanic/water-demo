// Ocean wave spectrum.
//
// A Gerstner sum of 20 sinusoids can be made to move correctly, but it cannot be
// made to *look* correct: real sea surface has energy at every scale at once, and
// twenty discrete components leave visible gaps between them. The spectral
// approach instead fills an entire N x N grid of wavevectors with the right
// statistics and inverse-transforms it into a displacement field.
//
// This module does the CPU half: turning wind conditions into the initial
// complex amplitudes h0(k). It is deterministic — the same seed and parameters
// always produce the same ocean — and it runs once per parameter change, not
// per frame.
//
// Model: JONSWAP (a fetch-limited refinement of Pierson-Moskowitz) with a
// cos^2s directional spread, plus a short-wave cutoff.
//
// References are all standard published oceanography / graphics material:
//   Hasselmann et al. 1973 (JONSWAP), Pierson & Moskowitz 1964,
//   Tessendorf, "Simulating Ocean Water" (the h0 / e^{i w t} formulation).

import { GRAVITY, TAU, mulberry32 } from '../core/util.js';

/**
 * Cascade layout.
 *
 * Three overlapping grids, each covering its own band of wavelengths. One grid
 * cannot do the job: a domain large enough for a 300 m swell has a cell size of
 * over a metre, which cannot represent capillary chop, and a domain fine enough
 * for chop repeats visibly every few metres.
 *
 * The k-range cutoffs make the bands disjoint so energy is never counted twice
 * where the domains overlap.
 */
export const CASCADES = [
	{ size: 512, kMin: 0.0, kMax: 0.055 },   // swell — wavelengths above ~114 m
	{ size: 96, kMin: 0.055, kMax: 0.35 },  // wind sea
	{ size: 18, kMin: 0.35, kMax: 1e9 },    // chop and ripples
];

/**
 * JONSWAP energy density at wavenumber magnitude k.
 *
 * @param {number} k      wavenumber magnitude, rad/m
 * @param {number} wind   wind speed at 10 m, m/s
 * @param {number} fetch  fetch length, m
 */
function jonswap( k, wind, fetch ) {

	if ( k < 1e-6 ) return 0;

	const omega = Math.sqrt( GRAVITY * k );

	// Peak angular frequency for the given wind and fetch.
	const dimensionlessFetch = GRAVITY * fetch / ( wind * wind );
	const omegaPeak = 22 * Math.pow( dimensionlessFetch, - 0.33 ) * GRAVITY / wind;

	// Phillips' alpha, fetch-dependent.
	const alpha = 0.076 * Math.pow( GRAVITY * fetch / ( wind * wind ), - 0.22 );

	// Peak enhancement.
	const sigma = omega <= omegaPeak ? 0.07 : 0.09;
	const r = Math.exp( - ( ( omega - omegaPeak ) ** 2 ) / ( 2 * sigma * sigma * omegaPeak * omegaPeak ) );
	const gamma = 3.3;

	const s = alpha * GRAVITY * GRAVITY / Math.pow( omega, 5 )
		* Math.exp( - 1.25 * Math.pow( omegaPeak / omega, 4 ) )
		* Math.pow( gamma, r );

	// S(omega) -> S(k): dω/dk = g / (2ω)
	return s * GRAVITY / ( 2 * omega );

}

/**
 * Directional spreading. cos^(2s) around the wind axis, with the exponent
 * falling for short waves so chop is close to isotropic while swell stays in a
 * tight fan — the same physical fact the Gerstner path models with per-band
 * spread values.
 */
function directionalSpread( theta, k, wind ) {

	const omega = Math.sqrt( GRAVITY * k );
	const omegaPeak = GRAVITY / Math.max( 1, wind );

	const ratio = omega / Math.max( 1e-4, omegaPeak );
	const s = ratio < 1
		? 6.97 * Math.pow( ratio, 4.06 )
		: 9.77 * Math.pow( ratio, - 2.33 );

	const spread = Math.pow( Math.abs( Math.cos( theta * 0.5 ) ), 2 * Math.max( 0.5, s ) );

	// A small isotropic floor keeps the surface from becoming a pure corduroy
	// pattern when the wind axis dominates completely.
	return spread * 0.94 + 0.06;

}

/**
 * Build the initial complex amplitudes for one cascade.
 *
 * Returns a Float32Array of N*N vec4: (h0.re, h0.im, h0conj(-k).re, h0conj(-k).im).
 * Packing both halves means the GPU evolution kernel needs one fetch, not two
 * with a wrapped index.
 *
 * @param {object} cascade  one of CASCADES
 * @param {number} N        grid resolution
 * @param {object} p        { windSpeed, windAngle, fetch, waveHeight, swell }
 * @param {number} seed
 */
export function buildInitialSpectrum( cascade, N, p, seed ) {

	const data = new Float32Array( N * N * 4 );

	const L = cascade.size;
	const rnd = mulberry32( seed ^ ( L * 2654435761 ) );

	const windRad = p.windAngle * Math.PI / 180;
	const windX = Math.sin( windRad );
	const windZ = Math.cos( windRad );

	const wind = Math.max( 0.5, p.windSpeed );
	const fetch = Math.max( 1000, p.fetch ?? 120000 );

	// Cutoff for waves too short for this grid to resolve — without it, energy
	// above Nyquist aliases straight back into the visible band as noise.
	const kNyquist = Math.PI * N / L;
	const kCut = kNyquist * 0.85;

	// dk^2 factor turns spectral density into per-cell amplitude.
	const dk = TAU / L;
	const dk2 = dk * dk;

	for ( let z = 0; z < N; z ++ ) {

		for ( let x = 0; x < N; x ++ ) {

			const i = ( z * N + x ) * 4;

			// Centred wavevector grid.
			const nx = x - N / 2;
			const nz = z - N / 2;

			const kx = nx * dk;
			const kz = nz * dk;
			const kLen = Math.hypot( kx, kz );

			// Two Gaussians via Box-Muller, consumed in a fixed order so the
			// field stays reproducible.
			const u1 = Math.max( 1e-9, rnd() );
			const u2 = rnd();
			const mag = Math.sqrt( - 2 * Math.log( u1 ) );
			const gr = mag * Math.cos( TAU * u2 );
			const gi = mag * Math.sin( TAU * u2 );

			if ( kLen < 1e-6 || kLen < cascade.kMin || kLen >= cascade.kMax || kLen > kCut ) {

				data[ i ] = 0; data[ i + 1 ] = 0; data[ i + 2 ] = 0; data[ i + 3 ] = 0;
				continue;

			}

			const theta = Math.atan2( kx, kz ) - Math.atan2( windX, windZ );

			const energy = jonswap( kLen, wind, fetch )
				* directionalSpread( theta, kLen, wind )
				/ kLen                                  // Jacobian of the polar -> cartesian k grid
				* dk2;

			// h0 = (1/sqrt2) * (gr + i gi) * sqrt(S)
			const amp = Math.sqrt( Math.max( 0, energy ) * 0.5 );

			data[ i ] = gr * amp;
			data[ i + 1 ] = gi * amp;

		}

	}

	// Second pass: fill the conj(h0(-k)) half by *looking up* the value already
	// stored at the mirrored grid location.
	//
	// Drawing an independent random for this half instead would break the
	// Hermitian symmetry h(-k) = conj(h(k)), and the inverse transform would then
	// produce a complex field rather than a real one. That matters more than it
	// sounds: two real fields are packed into each complex transform, so a
	// spurious imaginary part does not merely add noise — it leaks one field
	// directly into the other.
	//
	// Centred grid: index x holds nx = x - N/2, so -k lives at index (N - x) % N.
	for ( let z = 0; z < N; z ++ ) {

		const zm = ( N - z ) % N;

		for ( let x = 0; x < N; x ++ ) {

			const xm = ( N - x ) % N;

			const i = ( z * N + x ) * 4;
			const m = ( zm * N + xm ) * 4;

			data[ i + 2 ] = data[ m ];
			data[ i + 3 ] = - data[ m + 1 ];

		}

	}

	return data;

}

/**
 * Root-mean-square surface elevation implied by a set of h0 buffers.
 *
 * Used to normalise the cascades so the "wave height" slider means significant
 * wave height in metres, exactly as it does on the Gerstner path — the two wave
 * engines must agree on what the number means or switching quality tiers would
 * change the sea state.
 */
export function significantHeightOf( buffers ) {

	let variance = 0;

	for ( const data of buffers ) {

		for ( let i = 0; i < data.length; i += 4 ) {

			// |h0|^2 + |h0conj(-k)|^2 contributes to the elevation variance.
			variance += data[ i ] * data[ i ] + data[ i + 1 ] * data[ i + 1 ]
				+ data[ i + 2 ] * data[ i + 2 ] + data[ i + 3 ] * data[ i + 3 ];

		}

	}

	return 4 * Math.sqrt( variance );

}

/* ------------------------------------------------------------------------- */
/* CPU reference transform — used only by the verification harness.           */
/*                                                                            */
/* The GPU FFT is checked against this, numerically, before anything is drawn. */
/* A GPU transform that is subtly wrong produces a plausible-looking but       */
/* incorrect ocean, and no amount of staring at screenshots will find it.      */
/* ------------------------------------------------------------------------- */

/**
 * Naive O(N^2) 1D DFT with an explicit sign, for verifying the GPU FFT.
 *
 * @param {Float32Array} re  length N
 * @param {Float32Array} im  length N
 * @param {number} sign      -1 forward, +1 inverse (no normalisation)
 */
export function referenceDFT1D( re, im, sign ) {

	const N = re.length;
	const outRe = new Float64Array( N );
	const outIm = new Float64Array( N );

	for ( let k = 0; k < N; k ++ ) {

		let sr = 0;
		let si = 0;

		for ( let n = 0; n < N; n ++ ) {

			const a = sign * TAU * k * n / N;
			const c = Math.cos( a );
			const s = Math.sin( a );
			sr += re[ n ] * c - im[ n ] * s;
			si += re[ n ] * s + im[ n ] * c;

		}

		outRe[ k ] = sr;
		outIm[ k ] = si;

	}

	return { re: outRe, im: outIm };

}
