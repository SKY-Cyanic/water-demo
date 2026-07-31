// Small deterministic / numeric helpers shared across the demo.
// Everything here is allocation-free at call time where it matters.

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

/** Gravity used by the deep-water dispersion relation, m/s^2. */
export const GRAVITY = 9.81;

/**
 * mulberry32 — compact deterministic 32-bit PRNG (public domain algorithm).
 * Same seed always yields the same ocean, which is required for reproducible QA.
 */
export function mulberry32( seed ) {

	let a = seed >>> 0;

	return function () {

		a = ( a + 0x6D2B79F5 ) >>> 0;
		let t = Math.imul( a ^ ( a >>> 15 ), 1 | a );
		t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

export const clamp = ( x, lo, hi ) => x < lo ? lo : x > hi ? hi : x;
export const saturate = ( x ) => x < 0 ? 0 : x > 1 ? 1 : x;
export const lerp = ( a, b, t ) => a + ( b - a ) * t;
export const invLerp = ( a, b, x ) => a === b ? 0 : ( x - a ) / ( b - a );

export function smoothstep( t ) {

	t = saturate( t );
	return t * t * ( 3 - 2 * t );

}

/**
 * Framerate-independent exponential approach.
 * `lambda` is the rate; larger converges faster.
 */
export function damp( current, target, lambda, dt ) {

	return lerp( target, current, Math.exp( - lambda * dt ) );

}

/** Wrap into [0, m). Correct for negative inputs, unlike `%`. */
export function wrap( x, m ) {

	return x - Math.floor( x / m ) * m;

}

/** Format a number with a fixed number of decimals, no locale surprises. */
export function fmt( x, digits = 2 ) {

	if ( ! Number.isFinite( x ) ) return '–';
	return x.toFixed( digits );

}

/* -------------------------------------------------------------------------
   Colour helpers.
   The demo authors colours in sRGB hex (readable in presets and in the colour
   picker) and converts to linear-light for shading maths.
   ------------------------------------------------------------------------- */

export function srgbToLinear( c ) {

	return c <= 0.04045 ? c / 12.92 : Math.pow( ( c + 0.055 ) / 1.055, 2.4 );

}

export function linearToSrgb( c ) {

	return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow( c, 1 / 2.4 ) - 0.055;

}

/** '#rrggbb' → [r, g, b] in sRGB 0..1. */
export function hexToRgb( hex ) {

	const n = parseInt( hex.slice( 1 ), 16 );
	return [ ( n >> 16 & 255 ) / 255, ( n >> 8 & 255 ) / 255, ( n & 255 ) / 255 ];

}

/** [r, g, b] in sRGB 0..1 → '#rrggbb'. */
export function rgbToHex( rgb ) {

	const q = ( v ) => Math.round( saturate( v ) * 255 ).toString( 16 ).padStart( 2, '0' );
	return '#' + q( rgb[ 0 ] ) + q( rgb[ 1 ] ) + q( rgb[ 2 ] );

}
