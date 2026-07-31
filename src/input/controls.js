// Fly camera.
//
// Deliberately not OrbitControls: this demo has to fly a viewer smoothly down
// through the surface and back out, and an orbit rig fights that — it always
// wants to point at a fixed target and its polar clamp gets in the way exactly
// where the interesting transition happens.
//
// Drag to look, WASD to move, Q/E for depth, wheel for speed.

import { Vector3 } from 'three/webgpu';
import { clamp, damp } from '../core/util.js';

const KEY_MAP = {
	KeyW: 'fwd', ArrowUp: 'fwd',
	KeyS: 'back', ArrowDown: 'back',
	KeyA: 'left', ArrowLeft: 'left',
	KeyD: 'right', ArrowRight: 'right',
	KeyQ: 'down',
	KeyE: 'up',
	Space: 'up',
};

// Opening shot: eye height of someone on a small boat, looking a little off-axis
// toward the default preset's sun so the glitter track is in frame from frame one.
export const DEFAULT_VIEW = {
	position: new Vector3( 0, 4.5, 0 ),
	yaw: Math.PI * 1.18,
	pitch: - 0.075,
};

export class FlyControls {

	constructor( camera, domElement ) {

		// Null while flying; a live Vector3 the caller keeps updating while orbiting.
		this.orbitTarget = null;
		this.orbitDistance = 26;


		this.camera = camera;
		this.dom = domElement;

		this.yaw = DEFAULT_VIEW.yaw;
		this.pitch = DEFAULT_VIEW.pitch;
		this.position = DEFAULT_VIEW.position.clone();

		this.speed = 9;          // metres/second, wheel-adjustable
		this.minY = - 70;
		this.maxY = 240;
		this.enabled = true;

		// Smoothed values so the camera never snaps.
		this._yaw = this.yaw;
		this._pitch = this.pitch;
		this._vel = new Vector3();

		this._keys = Object.create( null );
		this._dragging = false;
		this._pointerId = null;
		this._lastX = 0;
		this._lastY = 0;
		this._boost = false;

		// Scratch — the update loop must not allocate.
		this._fwd = new Vector3();
		this._right = new Vector3();
		this._wish = new Vector3();

		this._bind();
		this.applyToCamera();

	}

	_bind() {

		const dom = this.dom;

		this._onPointerDown = ( e ) => {

			if ( ! this.enabled || e.button !== 0 ) return;
			this._dragging = true;
			this._pointerId = e.pointerId;
			this._lastX = e.clientX;
			this._lastY = e.clientY;
			dom.setPointerCapture( e.pointerId );
			dom.classList.add( 'dragging' );

		};

		this._onPointerMove = ( e ) => {

			if ( ! this._dragging || e.pointerId !== this._pointerId ) return;

			const dx = e.clientX - this._lastX;
			const dy = e.clientY - this._lastY;
			this._lastX = e.clientX;
			this._lastY = e.clientY;

			// Scale by viewport height so drag sensitivity is resolution-independent.
			const k = 2.6 / Math.max( 400, window.innerHeight );
			this.yaw -= dx * k;
			this.pitch = clamp( this.pitch - dy * k, - 1.53, 1.53 );

		};

		this._onPointerUp = ( e ) => {

			if ( e.pointerId !== this._pointerId ) return;
			this._dragging = false;
			this._pointerId = null;
			if ( dom.hasPointerCapture( e.pointerId ) ) dom.releasePointerCapture( e.pointerId );
			dom.classList.remove( 'dragging' );

		};

		this._onWheel = ( e ) => {

			if ( ! this.enabled ) return;
			e.preventDefault();

			// Orbiting, the wheel is a dolly; flying, it is a throttle. Same gesture,
			// and in both modes it means "closer / further from what I am looking at".
			if ( this.orbitTarget ) {

				this.orbitDistance = clamp( this.orbitDistance * Math.exp( e.deltaY * 0.0015 ), 8, 140 );
				return;

			}

			this.speed = clamp( this.speed * Math.exp( - e.deltaY * 0.0012 ), 0.6, 220 );

		};

		this._onKeyDown = ( e ) => {

			if ( e.target !== document.body && e.target.tagName !== 'CANVAS' ) return;

			const action = KEY_MAP[ e.code ];
			if ( action ) {

				this._keys[ action ] = true;
				e.preventDefault();

			}

			if ( e.code === 'ShiftLeft' || e.code === 'ShiftRight' ) this._boost = true;

		};

		this._onKeyUp = ( e ) => {

			const action = KEY_MAP[ e.code ];
			if ( action ) this._keys[ action ] = false;
			if ( e.code === 'ShiftLeft' || e.code === 'ShiftRight' ) this._boost = false;

		};

		// Releasing focus must not leave a key stuck down.
		this._onBlur = () => {

			for ( const k in this._keys ) this._keys[ k ] = false;
			this._boost = false;
			this._dragging = false;
			dom.classList.remove( 'dragging' );

		};

		dom.addEventListener( 'pointerdown', this._onPointerDown );
		dom.addEventListener( 'pointermove', this._onPointerMove );
		dom.addEventListener( 'pointerup', this._onPointerUp );
		dom.addEventListener( 'pointercancel', this._onPointerUp );
		dom.addEventListener( 'wheel', this._onWheel, { passive: false } );
		dom.addEventListener( 'contextmenu', ( e ) => e.preventDefault() );

		window.addEventListener( 'keydown', this._onKeyDown );
		window.addEventListener( 'keyup', this._onKeyUp );
		window.addEventListener( 'blur', this._onBlur );

	}

	reset() {

		this.position.copy( DEFAULT_VIEW.position );
		this.yaw = DEFAULT_VIEW.yaw;
		this.pitch = DEFAULT_VIEW.pitch;
		this._yaw = this.yaw;
		this._pitch = this.pitch;
		this._vel.set( 0, 0, 0 );
		this.speed = 9;
		this.applyToCamera();

	}

	/**
	 * Orbit a point instead of flying.
	 *
	 * The same yaw and pitch drive both modes, so a drag means the same thing in
	 * each and switching never re-orients the view under the user's hand. The
	 * difference is only which end of the stick is held: flying rotates the eye
	 * about itself, orbiting swings it around the target.
	 *
	 * @param {Vector3|null} target  null returns to fly mode
	 */
	setOrbitTarget( target ) {

		if ( ! target ) {

			this.orbitTarget = null;
			return;

		}

		if ( ! this.orbitTarget ) {

			// Enter at the distance the eye already is, so the switch is a change of
			// control rather than a cut.
			this.orbitDistance = clamp( this.position.distanceTo( target ), 8, 140 );

		}

		this.orbitTarget = target;

	}

	update( dt ) {

		// Look damping. Note the yaw target is unwrapped, so this never takes the
		// long way around.
		this._yaw = damp( this._yaw, this.yaw, 26, dt );
		this._pitch = damp( this._pitch, this.pitch, 26, dt );

		if ( this.orbitTarget ) {

			// Forward is toward the target, so the eye sits the other way along it.
			const cp = Math.cos( this._pitch );
			const d = this.orbitDistance;

			this.position.set(
				this.orbitTarget.x + Math.sin( this._yaw ) * cp * d,
				this.orbitTarget.y - Math.sin( this._pitch ) * d,
				this.orbitTarget.z + Math.cos( this._yaw ) * cp * d
			);

			// Still clamped: orbiting under a wave and orbiting into the sky are
			// both worse than a short leash.
			this.position.y = clamp( this.position.y, this.minY, this.maxY );

			this._vel.set( 0, 0, 0 );
			this.applyToCamera();
			return;

		}

		const cp = Math.cos( this._pitch );
		this._fwd.set(
			- Math.sin( this._yaw ) * cp,
			Math.sin( this._pitch ),
			- Math.cos( this._yaw ) * cp
		);
		this._right.set( Math.cos( this._yaw ), 0, - Math.sin( this._yaw ) );

		const k = this._keys;
		this._wish.set( 0, 0, 0 );

		if ( k.fwd ) this._wish.add( this._fwd );
		if ( k.back ) this._wish.sub( this._fwd );
		if ( k.right ) this._wish.add( this._right );
		if ( k.left ) this._wish.sub( this._right );
		if ( k.up ) this._wish.y += 1;
		if ( k.down ) this._wish.y -= 1;

		if ( this._wish.lengthSq() > 0 ) this._wish.normalize();

		const speed = this.speed * ( this._boost ? 3.4 : 1 );
		this._wish.multiplyScalar( speed );

		// Exponential approach gives weightless-but-not-twitchy motion.
		this._vel.x = damp( this._vel.x, this._wish.x, 9, dt );
		this._vel.y = damp( this._vel.y, this._wish.y, 9, dt );
		this._vel.z = damp( this._vel.z, this._wish.z, 9, dt );

		this.position.addScaledVector( this._vel, dt );
		this.position.y = clamp( this.position.y, this.minY, this.maxY );

		this.applyToCamera();

	}

	applyToCamera() {

		const cam = this.camera;
		cam.position.copy( this.position );
		// Yaw around Y then pitch around the local X: no roll, ever.
		cam.rotation.set( this._pitch, this._yaw, 0, 'YXZ' );
		cam.updateMatrixWorld();

	}

	dispose() {

		const dom = this.dom;
		dom.removeEventListener( 'pointerdown', this._onPointerDown );
		dom.removeEventListener( 'pointermove', this._onPointerMove );
		dom.removeEventListener( 'pointerup', this._onPointerUp );
		dom.removeEventListener( 'pointercancel', this._onPointerUp );
		dom.removeEventListener( 'wheel', this._onWheel );
		window.removeEventListener( 'keydown', this._onKeyDown );
		window.removeEventListener( 'keyup', this._onKeyUp );
		window.removeEventListener( 'blur', this._onBlur );

	}

}
