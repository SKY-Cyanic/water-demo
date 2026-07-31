// Settings panel.
//
// Hand-rolled rather than pulled from a GUI library: it is a few hundred lines,
// it keeps the dependency list at exactly one package, and it means the layout
// and visual language are this demo's own rather than borrowed from anything.
//
// Controls are declared as data and bound directly to env.params, so a preset
// cross-fade that rewrites those params is reflected in the panel by the same
// refresh path that a user drag uses. There is no second copy of the state.

import { PRESETS } from '../env/presets.js';
import { fmt } from '../core/util.js';

const QUALITY_LEVELS = [ 'low', 'medium', 'high', 'ultra' ];

/** Which params force a wave-field rebuild rather than just a uniform write. */
const REBUILD_KEYS = new Set( [ 'windSpeed', 'windAngle', 'waveScale' ] );

const SECTIONS = [

	{
		title: 'Environment', open: true, rows: [
			{ kind: 'slider', key: 'sunElevation', label: 'Sun elevation', min: - 6, max: 89, step: 0.5, unit: '°' },
			{ kind: 'slider', key: 'sunAzimuth', label: 'Sun azimuth', min: 0, max: 360, step: 1, unit: '°' },
			{ kind: 'slider', key: 'sunIntensity', label: 'Sun intensity', min: 0, max: 2.5, step: 0.01 },
			{ kind: 'slider', key: 'cloudCoverage', label: 'Cloud cover', min: 0, max: 1, step: 0.01 },
			{ kind: 'slider', key: 'cloudSpeed', label: 'Cloud speed', min: 0, max: 4, step: 0.05 },
			{ kind: 'slider', key: 'fogDensity', label: 'Haze density', min: 0, max: 0.4, step: 0.002, digits: 3 },
			{ kind: 'slider', key: 'exposure', label: 'Exposure', min: 0.2, max: 3, step: 0.01 },
		],
	},

	{
		title: 'Waves', open: true, rows: [
			{ kind: 'slider', key: 'waveHeight', label: 'Wave height', min: 0.05, max: 8, step: 0.05, unit: ' m', hint: 'significant height' },
			{ kind: 'slider', key: 'waveChoppy', label: 'Steepness', min: 0, max: 1, step: 0.01 },
			{ kind: 'slider', key: 'windSpeed', label: 'Wind speed', min: 0.5, max: 28, step: 0.1, unit: ' m/s' },
			{ kind: 'slider', key: 'windAngle', label: 'Wind direction', min: 0, max: 360, step: 1, unit: '°' },
			{ kind: 'slider', key: 'waveScale', label: 'Wave scale', min: 0.3, max: 2.2, step: 0.01 },
			{ kind: 'slider', key: 'detailStrength', label: 'Ripple detail', min: 0, max: 2.5, step: 0.02 },
		],
	},

	{
		title: 'Water', rows: [
			{ kind: 'color', key: 'waterDeep', label: 'Deep' },
			{ kind: 'color', key: 'waterShallow', label: 'Shallow' },
			{ kind: 'color', key: 'waterScatter', label: 'Scatter' },
			{ kind: 'slider', key: 'waterClarity', label: 'Clarity', min: 0.2, max: 3, step: 0.01 },
			{ kind: 'slider', key: 'roughness', label: 'Roughness', min: 0.006, max: 0.4, step: 0.002, digits: 3 },
			{ kind: 'slider', key: 'sssStrength', label: 'Crest glow', min: 0, max: 3, step: 0.02 },
			{ kind: 'slider', key: 'reflectivity', label: 'Reflectivity', min: 0, max: 1.6, step: 0.01 },
		],
	},

	{
		title: 'Foam', rows: [
			{ kind: 'slider', key: 'foamAmount', label: 'Amount', min: 0, max: 1.6, step: 0.01 },
			{ kind: 'slider', key: 'foamThreshold', label: 'Threshold', min: 0.1, max: 0.95, step: 0.01 },
			{ kind: 'slider', key: 'foamPersistence', label: 'Persistence', min: 0, max: 0.98, step: 0.01 },
			{ kind: 'slider', key: 'foamSharpness', label: 'Sharpness', min: 0.4, max: 2.5, step: 0.02 },
			{ kind: 'color', key: 'foamColor', label: 'Colour' },
		],
	},

	{
		title: 'Underwater', rows: [
			{ kind: 'slider', key: 'uwVisibility', label: 'Visibility', min: 3, max: 60, step: 0.5, unit: ' m' },
			{ kind: 'slider', key: 'causticStrength', label: 'Caustics', min: 0, max: 2.5, step: 0.02 },
			{ kind: 'slider', key: 'particleDensity', label: 'Particles', min: 0, max: 2, step: 0.02 },
			{ kind: 'toggle', key: 'seabedEnabled', label: 'Seabed' },
			{ kind: 'slider', key: 'seabedDepth', label: 'Seabed depth', min: 2, max: 60, step: 0.5, unit: ' m' },
			{ kind: 'color', key: 'seabedColor', label: 'Seabed colour' },
		],
	},

	{
		title: 'Performance', open: true, rows: [
			{ kind: 'seg', id: 'quality', label: 'Quality', options: QUALITY_LEVELS, labels: [ 'Low', 'Med', 'High', 'Ultra' ] },
			{ kind: 'appSlider', id: 'resolutionScale', label: 'Resolution', min: 0.5, max: 1, step: 0.05 },
			{ kind: 'appToggle', id: 'autoQuality', label: 'Auto quality' },
			{ kind: 'appToggle', id: 'showStats', label: 'Show stats (F)' },
			{ kind: 'appToggle', id: 'forceWebGL', label: 'Force WebGL 2 (reloads)' },
			{ kind: 'note', text: 'Wave and foam detail scale with quality. Auto quality lowers render resolution first, then the tier, if frame time stays above budget.' },
		],
	},

];

export class Panel {

	constructor( app ) {

		this.app = app;
		this.env = app.env;

		this.el = document.getElementById( 'panel' );
		this.body = document.getElementById( 'panel_body' ) || document.getElementById( 'panel-body' );
		this.status = document.getElementById( 'panel-status' );
		this.showBtn = document.getElementById( 'panel-show' );
		this.toggleBtn = document.getElementById( 'panel-toggle' );
		this.hud = document.getElementById( 'hud' );
		this.hint = document.getElementById( 'hint' );
		this.toast = document.getElementById( 'toast' );

		this.visible = true;
		this._rows = [];
		this._toastTimer = 0;
		this._hintTimer = 0;

		this._buildPresets();
		this._buildSections();

		this.toggleBtn.addEventListener( 'click', () => this.setVisible( false ) );
		this.showBtn.addEventListener( 'click', () => this.setVisible( true ) );

		this.el.hidden = false;
		this.refresh();

	}

	/* ------------------------------------------------------------- build */

	_buildPresets() {

		const sec = this._section( 'Presets', true );
		const wrap = document.createElement( 'div' );
		wrap.className = 'presets';

		this._presetButtons = new Map();

		for ( const preset of PRESETS ) {

			const btn = document.createElement( 'button' );
			btn.type = 'button';
			btn.setAttribute( 'aria-pressed', 'false' );

			const sw = document.createElement( 'span' );
			sw.className = 'swatch';
			sw.style.background = preset.swatch;

			const name = document.createElement( 'span' );
			name.textContent = preset.label;

			btn.append( sw, name );
			btn.addEventListener( 'click', () => this.app.applyPreset( preset.id ) );

			wrap.appendChild( btn );
			this._presetButtons.set( preset.id, btn );

		}

		sec.body.appendChild( wrap );

	}

	_section( title, open = false ) {

		const details = document.createElement( 'details' );
		details.className = 'sec';
		details.open = open;

		const summary = document.createElement( 'summary' );
		summary.textContent = title;

		const body = document.createElement( 'div' );
		body.className = 'sec-body';

		details.append( summary, body );
		this.body.appendChild( details );

		return { details, body };

	}

	_buildSections() {

		for ( const section of SECTIONS ) {

			const sec = this._section( section.title, section.open === true );

			for ( const row of section.rows ) {

				const built = this._buildRow( row );
				if ( built ) sec.body.appendChild( built );

			}

		}

	}

	_buildRow( row ) {

		switch ( row.kind ) {

			case 'slider': return this._slider( row, () => this.env.params[ row.key ], ( v ) => {

				this.env.params[ row.key ] = v;
				this.env.dirty = true;
				if ( REBUILD_KEYS.has( row.key ) ) this.app.rebuildWaves();

			} );

			case 'appSlider': return this._slider( row, () => this.app.getSetting( row.id ), ( v ) => this.app.setSetting( row.id, v ) );

			case 'color': return this._color( row );
			case 'toggle': return this._toggle( row, () => !! this.env.params[ row.key ], ( v ) => {

				this.env.params[ row.key ] = v ? 1 : 0;
				this.env.dirty = true;

			} );

			case 'appToggle': return this._toggle( row, () => !! this.app.getSetting( row.id ), ( v ) => this.app.setSetting( row.id, v ) );
			case 'seg': return this._seg( row );
			case 'note': {

				const p = document.createElement( 'p' );
				p.className = 'note';
				p.textContent = row.text;
				return p;

			}

			default: return null;

		}

	}

	_slider( row, get, set ) {

		const wrap = document.createElement( 'div' );
		wrap.className = 'row';

		const label = document.createElement( 'div' );
		label.className = 'row-label';

		const name = document.createElement( 'span' );
		name.textContent = row.label;

		const val = document.createElement( 'span' );
		val.className = 'row-val';

		label.append( name, val );

		const input = document.createElement( 'input' );
		input.type = 'range';
		input.min = row.min;
		input.max = row.max;
		input.step = row.step;
		input.setAttribute( 'aria-label', row.label );

		const digits = row.digits ?? ( row.step >= 1 ? 0 : row.step >= 0.05 ? 2 : 2 );
		const show = ( v ) => {

			val.textContent = fmt( v, digits ) + ( row.unit || '' );

		};

		input.addEventListener( 'input', () => {

			const v = parseFloat( input.value );
			set( v );
			show( v );

		} );

		wrap.append( label, input );

		this._rows.push( { refresh: () => {

			const v = get();
			if ( document.activeElement !== input ) input.value = String( v );
			show( v );

		} } );

		return wrap;

	}

	_color( row ) {

		const wrap = document.createElement( 'div' );
		wrap.className = 'row';

		const label = document.createElement( 'div' );
		label.className = 'row-label';

		const name = document.createElement( 'span' );
		name.textContent = row.label;

		const input = document.createElement( 'input' );
		input.type = 'color';
		input.setAttribute( 'aria-label', row.label );

		input.addEventListener( 'input', () => {

			this.env.params[ row.key ] = input.value;
			this.env.dirty = true;

		} );

		const holder = document.createElement( 'div' );
		holder.className = 'row-color';
		holder.append( input );

		label.append( name, holder );
		wrap.append( label );

		this._rows.push( { refresh: () => {

			if ( document.activeElement !== input ) input.value = this.env.params[ row.key ];

		} } );

		return wrap;

	}

	_toggle( row, get, set ) {

		const btn = document.createElement( 'button' );
		btn.type = 'button';
		btn.className = 'tog';

		const name = document.createElement( 'span' );
		name.textContent = row.label;

		const box = document.createElement( 'span' );
		box.className = 'tog-box';

		btn.append( name, box );
		btn.addEventListener( 'click', () => {

			set( ! get() );
			this.refresh();

		} );

		this._rows.push( { refresh: () => btn.setAttribute( 'aria-pressed', get() ? 'true' : 'false' ) } );

		const wrap = document.createElement( 'div' );
		wrap.className = 'row';
		wrap.append( btn );
		return wrap;

	}

	_seg( row ) {

		const wrap = document.createElement( 'div' );
		wrap.className = 'row';

		const label = document.createElement( 'div' );
		label.className = 'row-label';
		const name = document.createElement( 'span' );
		name.textContent = row.label;
		label.append( name );

		const seg = document.createElement( 'div' );
		seg.className = 'seg';

		const buttons = [];

		row.options.forEach( ( opt, i ) => {

			const b = document.createElement( 'button' );
			b.type = 'button';
			b.textContent = row.labels?.[ i ] ?? opt;
			b.addEventListener( 'click', () => {

				this.app.setSetting( row.id, opt );
				this.refresh();

			} );
			seg.appendChild( b );
			buttons.push( { b, opt } );

		} );

		wrap.append( label, seg );

		this._rows.push( { refresh: () => {

			const cur = this.app.getSetting( row.id );
			for ( const { b, opt } of buttons ) b.setAttribute( 'aria-pressed', opt === cur ? 'true' : 'false' );

		} } );

		return wrap;

	}

	/* ------------------------------------------------------------ update */

	refresh() {

		for ( let i = 0; i < this._rows.length; i ++ ) this._rows[ i ].refresh();

		const cur = this.app.presetId;
		for ( const [ id, btn ] of this._presetButtons ) {

			btn.setAttribute( 'aria-pressed', id === cur ? 'true' : 'false' );

		}

	}

	setVisible( v ) {

		this.visible = v;
		this.el.hidden = ! v;
		this.showBtn.hidden = v;

	}

	toggleVisible() {

		this.setVisible( ! this.visible );

	}

	setStatus( text ) {

		if ( this.status.textContent !== text ) this.status.textContent = text;

	}

	setStatsVisible( v ) {

		this.hud.hidden = ! v;

	}

	/* --------------------------------------------------------- ephemera */

	showHint( ms = 5000 ) {

		this.hint.hidden = false;
		this.hint.classList.remove( 'leaving' );
		clearTimeout( this._hintTimer );

		this._hintTimer = setTimeout( () => {

			this.hint.classList.add( 'leaving' );
			setTimeout( () => {

				this.hint.hidden = true;
				this.hint.classList.remove( 'leaving' );

			}, 500 );

		}, ms );

	}

	toastMessage( text, ms = 1400 ) {

		this.toast.textContent = text;
		this.toast.hidden = false;
		this.toast.classList.remove( 'leaving' );
		clearTimeout( this._toastTimer );

		this._toastTimer = setTimeout( () => {

			this.toast.classList.add( 'leaving' );
			setTimeout( () => {

				this.toast.hidden = true;
				this.toast.classList.remove( 'leaving' );

			}, 320 );

		}, ms );

	}

	/**
	 * Hide every piece of UI for a screenshot and return a restore function.
	 * Used by window.__capture() so QA images contain only the render.
	 */
	hideForCapture() {

		const state = {
			panel: this.el.hidden,
			show: this.showBtn.hidden,
			hud: this.hud.hidden,
			hint: this.hint.hidden,
			toast: this.toast.hidden,
		};

		this.el.hidden = true;
		this.showBtn.hidden = true;
		this.hud.hidden = true;
		this.hint.hidden = true;
		this.toast.hidden = true;

		return () => {

			this.el.hidden = state.panel;
			this.showBtn.hidden = state.show;
			this.hud.hidden = state.hud;
			this.hint.hidden = state.hint;
			this.toast.hidden = state.toast;

		};

	}

}

/** Small helper for the HUD, kept out of the render loop's hot path. */
export class Hud {

	constructor() {

		this.fps = document.getElementById( 'hud-fps' );
		this.ms = document.getElementById( 'hud-ms' );
		this.low = document.getElementById( 'hud-low' );
		this.backend = document.getElementById( 'hud-backend' );
		this.quality = document.getElementById( 'hud-quality' );
		this.scale = document.getElementById( 'hud-scale' );
		this.tris = document.getElementById( 'hud-tris' );

	}

	update( app ) {

		const d = app.diagnostics;

		this.fps.textContent = fmt( d.fps, 0 );
		this.fps.className = 'hud-v' + ( d.fps < 30 ? ' bad' : d.fps < 50 ? ' warn' : '' );

		this.ms.textContent = fmt( d.frameMs, 1 ) + ' ms';
		this.low.textContent = d.onePercentLow > 0 ? fmt( d.onePercentLow, 0 ) : '–';
		this.backend.textContent = app.backendName;
		this.quality.textContent = app.quality;
		this.scale.textContent = fmt( app.sizer.scale, 2 ) + '×';
		this.tris.textContent = ( app.renderer.info.render.triangles / 1000 ).toFixed( 0 ) + 'k';

	}

}
