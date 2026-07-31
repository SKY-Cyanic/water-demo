// Renderer bring-up: capability probe, WebGPU-first init with WebGL 2 fallback,
// resize / DPR management and device-loss surfacing.
//
// three r185's WebGPURenderer installs its own `getFallback` that swaps in the
// WebGL 2 backend when WebGPU is unavailable, so a single TSL codebase drives
// both backends. We still probe explicitly so the boot UI can say what happened.

import { WebGPURenderer, ACESFilmicToneMapping, SRGBColorSpace } from 'three/webgpu';
import { clamp } from './util.js';

/** Device-pixel-ratio ceiling per quality tier. */
export const DPR_CAP = { low: 1.0, medium: 1.25, high: 1.5, ultra: 2.0 };

/**
 * Probe WebGPU without throwing. Returns a reason string when unavailable so
 * the UI can explain rather than just failing.
 */
export async function probeWebGPU() {

	if ( typeof navigator === 'undefined' || navigator.gpu === undefined ) {

		return { ok: false, reason: 'navigator.gpu is not exposed by this browser.' };

	}

	try {

		const adapter = await navigator.gpu.requestAdapter();

		if ( adapter === null ) {

			return { ok: false, reason: 'No WebGPU adapter available (GPU may be blocklisted).' };

		}

		return { ok: true, adapter };

	} catch ( err ) {

		return { ok: false, reason: 'requestAdapter() failed: ' + ( err?.message ?? err ) };

	}

}

/**
 * Create and initialise the renderer.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} opts
 * @param {boolean} opts.forceWebGL  Skip WebGPU entirely (used by the fallback QA path).
 * @param {Function} opts.onDeviceLost
 * @param {Function} opts.onBackendError
 */
export async function createRenderer( canvas, opts = {} ) {

	const renderer = new WebGPURenderer( {
		canvas,
		antialias: true,
		alpha: false,
		// Water is a high-dynamic-range subject: the sun glitter track and the
		// deep shadowed troughs are several stops apart. Keep the default
		// half-float output buffer so tone mapping has real headroom.
		forceWebGL: opts.forceWebGL === true,
	} );

	renderer.toneMapping = ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.0;
	renderer.outputColorSpace = SRGBColorSpace;

	if ( opts.onDeviceLost ) {

		renderer.onDeviceLost = ( info ) => opts.onDeviceLost( info );

	}

	if ( opts.onBackendError ) {

		renderer.onError = ( err ) => opts.onBackendError( err );

	}

	await renderer.init();

	return renderer;

}

/** 'WebGPU' | 'WebGL 2' — reports what the renderer actually settled on. */
export function backendName( renderer ) {

	return renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL 2';

}

/**
 * Drives canvas sizing. The canvas is CSS-sized to fill the stage, so we only
 * ever set the drawing-buffer size (updateStyle = false).
 *
 * `scale` is the dynamic resolution multiplier the auto-quality system tunes.
 */
export class ViewportSizer {

	constructor( renderer, camera ) {

		this.renderer = renderer;
		this.camera = camera;
		this.dprCap = DPR_CAP.high;
		this.scale = 1;
		this.width = 1;
		this.height = 1;
		this.effectiveDpr = 1;
		this._onResize = () => this.apply();

		window.addEventListener( 'resize', this._onResize, { passive: true } );
		window.addEventListener( 'orientationchange', this._onResize, { passive: true } );

	}

	setDprCap( cap ) {

		this.dprCap = cap;
		this.apply();

	}

	setScale( scale ) {

		this.scale = clamp( scale, 0.5, 1 );
		this.apply();

	}

	apply() {

		const w = Math.max( 1, window.innerWidth );
		const h = Math.max( 1, window.innerHeight );
		const dpr = clamp( ( window.devicePixelRatio || 1 ) * this.scale, 0.5, this.dprCap );

		this.width = w;
		this.height = h;
		this.effectiveDpr = dpr;

		this.renderer.setPixelRatio( dpr );
		this.renderer.setSize( w, h, false );

		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();

		// Anything holding its own render targets has to follow the drawing
		// buffer, not the CSS size.
		this.onResize?.( Math.round( w * dpr ), Math.round( h * dpr ) );

	}

	dispose() {

		window.removeEventListener( 'resize', this._onResize );
		window.removeEventListener( 'orientationchange', this._onResize );

	}

}
