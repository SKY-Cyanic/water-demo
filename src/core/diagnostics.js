// Frame-time statistics and QA hooks.
//
// Everything reported here is measured, never estimated. `window.__perf()`
// returns a sample the verification loop can read straight out of the page, and
// `window.__capture()` hands back a PNG so screenshots are reproducible instead
// of being whatever the window manager happened to show.

const HISTORY = 1200;   // ~20 s at 60 Hz

export class Diagnostics {

	constructor() {

		// Ring buffer of frame times, ms. Preallocated — the sampler must not
		// allocate or it perturbs what it is measuring.
		this._frames = new Float32Array( HISTORY );
		this._n = 0;
		this._i = 0;

		this._emaMs = 16.7;
		this._lastReport = 0;

		this.fps = 0;
		this.frameMs = 0;
		this.onePercentLow = 0;

		// Scratch for percentile computation.
		this._sorted = new Float32Array( HISTORY );

		// Separate, explicitly-started window used by __perf().
		this._sample = null;

	}

	/** @param {number} dtMs wall-clock time for the frame just completed */
	push( dtMs ) {

		if ( ! ( dtMs > 0 ) || dtMs > 2000 ) return;

		this._frames[ this._i ] = dtMs;
		this._i = ( this._i + 1 ) % HISTORY;
		if ( this._n < HISTORY ) this._n ++;

		// Smoothed instantaneous readout for the HUD.
		this._emaMs += ( dtMs - this._emaMs ) * 0.06;
		this.frameMs = this._emaMs;
		this.fps = 1000 / Math.max( 0.001, this._emaMs );

		if ( this._sample ) {

			this._sample.frames.push( dtMs );

		}

	}

	/** Recompute the 1% low. Called at ~2 Hz, not per frame. */
	refreshPercentiles() {

		const n = this._n;
		if ( n < 30 ) return;

		const s = this._sorted.subarray( 0, n );
		s.set( this._frames.subarray( 0, n ) );
		s.sort();

		// Worst 1% of frames -> the slowest, i.e. the top of the sorted times.
		const idx = Math.max( 0, Math.floor( n * 0.99 ) - 1 );
		const worstMs = s[ idx ];
		this.onePercentLow = 1000 / Math.max( 0.001, worstMs );

	}

	/** Begin a measurement window for __perf(). */
	beginSample( label ) {

		this._sample = { label, frames: [], t0: performance.now() };

	}

	/** Close the window and reduce it to the numbers acceptance.md asks for. */
	endSample() {

		const s = this._sample;
		this._sample = null;

		if ( ! s || s.frames.length < 5 ) return null;

		const frames = s.frames.slice().sort( ( a, b ) => a - b );
		const n = frames.length;

		let sum = 0;
		for ( let i = 0; i < n; i ++ ) sum += frames[ i ];

		const avgMs = sum / n;
		const p99Ms = frames[ Math.max( 0, Math.floor( n * 0.99 ) - 1 ) ];
		const p95Ms = frames[ Math.max( 0, Math.floor( n * 0.95 ) - 1 ) ];

		return {
			label: s.label,
			seconds: +( ( performance.now() - s.t0 ) / 1000 ).toFixed( 2 ),
			frames: n,
			avgFps: +( 1000 / avgMs ).toFixed( 1 ),
			avgMs: +avgMs.toFixed( 2 ),
			medianMs: +frames[ n >> 1 ].toFixed( 2 ),
			p95Ms: +p95Ms.toFixed( 2 ),
			onePercentLowFps: +( 1000 / p99Ms ).toFixed( 1 ),
			worstMs: +frames[ n - 1 ].toFixed( 2 ),
		};

	}

	reset() {

		this._n = 0;
		this._i = 0;

	}

}

/**
 * Install the QA hooks the verification loop drives from outside the page.
 *
 * @param {object} app  the running application
 */
export function installQAHooks( app ) {

	// The live app object, for one-off diagnostics that do not deserve a
	// permanent hook of their own.
	window.__app = app;

	/**
	 * Measure for `seconds`, then resolve with real numbers.
	 * Usage from the harness:  await window.__perf(30)
	 */
	window.__perf = ( seconds = 30, label = 'sample' ) => new Promise( ( resolve ) => {

		app.diagnostics.beginSample( label );

		setTimeout( () => {

			const result = app.diagnostics.endSample();

			resolve( Object.assign( {
				backend: app.backendName,
				quality: app.quality,
				resolutionScale: +app.sizer.scale.toFixed( 3 ),
				devicePixelRatio: +app.sizer.effectiveDpr.toFixed( 3 ),
				viewport: `${app.sizer.width}x${app.sizer.height}`,
				drawingBuffer: `${Math.round( app.sizer.width * app.sizer.effectiveDpr )}x${Math.round( app.sizer.height * app.sizer.effectiveDpr )}`,
				triangles: app.renderer.info.render.triangles,
				drawCalls: app.renderer.info.render.drawCalls,
				preset: app.presetId,
				underwater: app.underwaterFactor > 0.5,
			}, result ) );

		}, seconds * 1000 );

	} );

	/**
	 * Step the simulation by hand and render each step.
	 *
	 * requestAnimationFrame does not fire for a page the browser considers
	 * hidden, which is exactly the state an embedded/automated viewport reports.
	 * Without this, every automated screenshot would capture the first frame
	 * after load and nothing would ever appear to animate.
	 *
	 * It also makes captures deterministic: the same seconds always produce the
	 * same sea state, independent of how fast the machine renders.
	 *
	 * @param {number} seconds  simulated time to advance
	 * @param {number} step     fixed timestep, seconds
	 */
	window.__advance = ( seconds = 1, step = 1 / 60 ) => {

		const steps = Math.max( 1, Math.round( seconds / step ) );

		for ( let i = 0; i < steps; i ++ ) {

			app.update( step );
			// app.render(), not renderer.render(): the foam history has to be
			// advanced too, or persistent foam never accumulates in a capture.
			app.render();

		}

		return { steps, waveTime: +app.waveTime.toFixed( 3 ) };

	};

	/**
	 * Wait until the browser has actually presented a frame.
	 *
	 * toDataURL() on a WebGPU canvas reads the *presented* surface, not the
	 * command buffer just submitted — so reading straight after render() can
	 * return an earlier frame. Chasing that produced a long run of screenshots
	 * that showed the previous camera position and led to hours of debugging a
	 * rendering bug that did not exist.
	 *
	 * The timeout is the fallback for a page the browser considers hidden, where
	 * requestAnimationFrame never fires at all.
	 */
	const presented = () => new Promise( ( resolve ) => {

		let done = false;
		const finish = () => { if ( ! done ) { done = true; resolve(); } };

		requestAnimationFrame( () => requestAnimationFrame( finish ) );
		setTimeout( finish, 300 );

	} );

	/**
	 * Render with the debug UI hidden and return a PNG data URL.
	 * Screenshots therefore capture exactly the drawing buffer, at a known size.
	 */
	window.__capture = async ( { hideUI = true, settle = 0 } = {} ) => {

		const restore = hideUI ? app.ui.hideForCapture() : null;

		if ( settle > 0 ) window.__advance( settle );

		// app.render(), not renderer.render(): the app decides whether the frame
		// goes through the underwater pipeline, and a capture that skipped it
		// would not be a picture of what the user actually sees.
		app.render();
		await presented();
		app.render();
		await presented();

		const url = app.renderer.domElement.toDataURL( 'image/png' );

		if ( restore ) restore();

		return url;

	};

	/** Current state, for logging alongside a capture. */
	window.__state = () => ( {
		backend: app.backendName,
		quality: app.quality,
		preset: app.presetId,
		fps: +app.diagnostics.fps.toFixed( 1 ),
		frameMs: +app.diagnostics.frameMs.toFixed( 2 ),
		onePercentLow: +app.diagnostics.onePercentLow.toFixed( 1 ),
		viewport: `${app.sizer.width}x${app.sizer.height}`,
		devicePixelRatio: +app.sizer.effectiveDpr.toFixed( 3 ),
		triangles: app.renderer.info.render.triangles,
		cameraY: +app.controls.position.y.toFixed( 2 ),
		surfaceY: +app.surfaceY.toFixed( 2 ),
		underwater: app.underwaterFactor,
		consoleErrors: app.consoleErrors.length,
		errors: app.consoleErrors.slice( 0, 8 ),
	} );

	/** Drive the demo from the harness without synthesising input events. */
	window.__set = ( patch ) => {

		if ( patch.preset ) app.applyPreset( patch.preset, patch.instant !== false );
		if ( patch.quality ) app.setQuality( patch.quality );
		if ( patch.camera ) {

			const c = patch.camera;
			if ( c.x !== undefined ) app.controls.position.x = c.x;
			if ( c.y !== undefined ) app.controls.position.y = c.y;
			if ( c.z !== undefined ) app.controls.position.z = c.z;
			if ( c.yaw !== undefined ) app.controls.yaw = app.controls._yaw = c.yaw;
			if ( c.pitch !== undefined ) app.controls.pitch = app.controls._pitch = c.pitch;
			app.controls.applyToCamera();

		}

		if ( patch.params ) Object.assign( app.env.params, patch.params );
		if ( patch.paused !== undefined ) app.setPaused( patch.paused );

		// App-level settings. Without this passthrough a harness asking for
		// autoQuality:false was silently ignored, and every performance number was
		// measured at whatever resolution the auto-scaler had already dropped to —
		// which is exactly the kind of measurement that looks like data and is not.
		for ( const key of [ 'autoQuality', 'resolutionScale', 'showStats' ] ) {

			if ( patch[ key ] !== undefined ) app.setSetting( key, patch[ key ] );

		}

		app.env.dirty = true;

		return window.__state();

	};

}
