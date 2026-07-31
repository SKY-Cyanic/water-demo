// Planar reflection of the floating objects.
//
// The water's reflection is an analytic sky lookup. That is exactly what makes
// the horizon continuous and the reflected sun land where the real one is — but
// a function of direction alone cannot know that there is a boat in the way. So
// the sea beside a hull showed sky where it should have shown hull, and no
// amount of foam at the waterline fixes that: a floating object with no
// reflection reads as a sticker.
//
// This adds the missing term and nothing else. It renders only the props — one
// small mesh, half resolution — and the water blends the result into the sky
// reflection it already computes.
//
// Why screenUV is the right lookup, with no projection maths: for a mirror
// plane at y = 0, a camera reflected through that plane sees, at each screen
// position, exactly what the real camera sees reflected at that same screen
// position. Reflecting the camera's world matrix through diag(1, -1, 1) is the
// whole of the setup. (It flips handedness, so the props render double-sided —
// which they already do, for the sails.)
//
// The surface is not actually a plane, so the lookup is displaced by the local
// surface gradient. That is the standard approximation and it is what makes the
// reflection ripple with the water rather than sitting on it like a decal.

import { HalfFloatType, LinearFilter, Matrix4, Mesh, PerspectiveCamera, Plane, RenderTarget, Scene, Vector3 } from 'three/webgpu';

const MIRROR = /*@__PURE__*/ new Matrix4().makeScale( 1, - 1, 1 );

// Everything below the waterline is cut away before mirroring. Without it the
// submerged hull — which is large, dark and, once reflected, appears *above*
// the plane — smeared across half the sea as a shadow with no source.
const WATERLINE = /*@__PURE__*/ new Plane( new Vector3( 0, 1, 0 ), 0 );

export class PropReflection {

	constructor( { scale = 0.5 } = {} ) {

		this.scale = scale;

		this.target = new RenderTarget( 2, 2, {
			// The props are lit in linear HDR like everything else, and sunlit
			// canvas comfortably exceeds 1.
			type: HalfFloatType,
			depthBuffer: true,
			stencilBuffer: false,
		} );
		this.target.texture.name = 'PropReflection';
		this.target.texture.minFilter = LinearFilter;
		this.target.texture.magFilter = LinearFilter;
		this.target.texture.generateMipmaps = false;

		this.scene = new Scene();

		this.camera = new PerspectiveCamera();
		this.camera.matrixAutoUpdate = false;

		this._meshes = [];

	}

	get texture() {

		return this.target.texture;

	}

	/**
	 * Mirror an object into the reflection scene.
	 *
	 * A second Mesh sharing the original's geometry and material, because an
	 * Object3D has one parent and the original has to stay in the main scene.
	 * Sharing is safe here: these materials place themselves in world space from
	 * uniforms, so an identity object matrix in either scene gives the same
	 * result.
	 */
	add( mesh ) {

		const clone = new Mesh( mesh.geometry, mesh.material );
		clone.name = mesh.name + 'Reflection';
		clone.frustumCulled = false;
		clone.matrixAutoUpdate = false;
		this.scene.add( clone );
		this._meshes.push( clone );

	}

	setSize( width, height ) {

		this.target.setSize(
			Math.max( 2, Math.round( width * this.scale ) ),
			Math.max( 2, Math.round( height * this.scale ) )
		);

	}

	/** Draw the mirrored props. Must run before the main scene render. */
	render( renderer, camera ) {

		this.camera.projectionMatrix.copy( camera.projectionMatrix );
		this.camera.projectionMatrixInverse.copy( camera.projectionMatrixInverse );
		this.camera.matrixWorld.multiplyMatrices( MIRROR, camera.matrixWorld );
		this.camera.matrixWorldNeedsUpdate = false;

		const previousTarget = renderer.getRenderTarget();
		const previousAlpha = renderer.getClearAlpha();

		// Coverage rides in alpha, so the background has to clear to zero — the
		// water uses it to decide where there is anything to reflect at all.
		const previousClip = renderer.clippingPlanes;

		renderer.clippingPlanes = [ WATERLINE ];
		renderer.setClearAlpha( 0 );
		renderer.setRenderTarget( this.target );
		renderer.clear();
		renderer.render( this.scene, this.camera );
		renderer.setRenderTarget( previousTarget );
		renderer.setClearAlpha( previousAlpha );
		renderer.clippingPlanes = previousClip;

	}

	dispose() {

		for ( const m of this._meshes ) this.scene.remove( m );
		this._meshes.length = 0;
		this.target.dispose();

	}

}
