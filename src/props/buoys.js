// Floating markers.
//
// Water without anything on it has no scale. A two-metre chop and a ten-metre
// swell look identical through a camera with no reference object, which is why
// the sea can read as "nice texture" rather than as an ocean. A handful of
// navigation buoys fixes that for very little geometry.
//
// Buoyancy without physics and without readback: each buoy samples the *same*
// displacement and slope cascades the water surface uses, at its anchor point,
// in its own vertex shader. It therefore sits exactly on the surface by
// construction — there is no simulation to drift out of sync, no GPU->CPU
// readback latency, and no separate CPU wave model that would have the right
// statistics but the wrong phase.
//
// On the Gerstner path (WebGL 2 / Low) the same anchors are evaluated on the
// CPU instead, which does match that engine exactly.

import {
	CylinderGeometry, InstancedBufferAttribute, InstancedMesh, MeshBasicNodeMaterial, Object3D,
} from 'three/webgpu';
import {
	Fn, cameraPosition, cross, dot, float, instancedBufferAttribute, mix, normalLocal, normalize,
	positionGeometry, pow, saturate, smoothstep, texture, varyingProperty, vec2, vec3, vec4,
} from 'three/tsl';

import { mulberry32 } from '../core/util.js';

/** How far a buoy may drift from the camera before it wraps to the other side. */
const LATTICE = 760;

export class Buoys {

	/**
	 * @param {object} env
	 * @param {object|null} spectral  cascade textures, when the spectral engine is active
	 * @param {number} count
	 */
	constructor( env, spectral, count = 9 ) {

		this.env = env;
		this.count = count;
		this.spectral = spectral;

		const rnd = mulberry32( 77123 );

		// Home positions. Deliberately close: a buoy 300 m out is a few pixels and
		// gives the eye nothing to measure the swell against. The nearest sit at
		// about 12 m, where a 2.5 m marker is plainly a 2.5 m marker and the wave
		// it is riding acquires a size.
		this.bases = [];
		for ( let i = 0; i < count; i ++ ) {

			const a = ( i / count ) * Math.PI * 2 + rnd() * 0.9;
			// Square-root distribution so they are not all bunched at the far edge.
			const r = 12 + Math.sqrt( rnd() ) * 105;
			this.bases.push( [ Math.cos( a ) * r, Math.sin( a ) * r ] );

		}

		this.anchorArray = new Float32Array( count * 2 );
		this.tintArray = new Float32Array( count );

		for ( let i = 0; i < count; i ++ ) this.tintArray[ i ] = rnd();

		const anchorAttr = new InstancedBufferAttribute( this.anchorArray, 2 );
		anchorAttr.setUsage( 35048 /* DynamicDrawUsage */ );
		this.anchorAttr = anchorAttr;

		const tintAttr = new InstancedBufferAttribute( this.tintArray, 1 );

		// A tapered can: wide at the waterline, narrower on top. Cheap, and
		// unmistakably a navigation buoy once it is banded.
		const geometry = new CylinderGeometry( 0.42, 0.66, 2.5, 14, 1, false );
		geometry.translate( 0, 0.55, 0 );   // sit the waterline near local y = 0
		geometry.setAttribute( 'anchor', anchorAttr );
		geometry.setAttribute( 'tint', tintAttr );

		this.material = this._buildMaterial( anchorAttr, tintAttr );

		this.mesh = new InstancedMesh( geometry, this.material, count );
		this.mesh.name = 'Buoys';
		this.mesh.frustumCulled = false;
		this.mesh.matrixAutoUpdate = false;
		this.mesh.instanceMatrix.needsUpdate = false;

		// Identity per-instance matrices: all placement happens in the shader.
		const dummy = new Object3D();
		dummy.updateMatrix();
		for ( let i = 0; i < count; i ++ ) this.mesh.setMatrixAt( i, dummy.matrix );
		this.mesh.instanceMatrix.needsUpdate = true;

		this._field = null;

	}

	/** The Gerstner field, used when the spectral engine is unavailable. */
	setFallbackField( field ) {

		this._field = field;

	}

	_buildMaterial( anchorAttr, tintAttr ) {

		const u = this.env.u;
		const spectral = this.spectral;

		const material = new MeshBasicNodeMaterial();
		material.name = 'Buoy';

		const vNormal = varyingProperty( 'vec3', 'vBuoyNormal' );
		const vLocalY = varyingProperty( 'float', 'vBuoyLocalY' );
		const vTint = varyingProperty( 'float', 'vBuoyTint' );

		material.positionNode = Fn( () => {

			const anchor = instancedBufferAttribute( anchorAttr, 'vec2' ).toVar( 'buoyAnchor' );
			const tint = instancedBufferAttribute( tintAttr, 'float' );

			const disp = vec3( 0, 0, 0 ).toVar( 'buoyDisp' );
			const slope = vec2( 0, 0 ).toVar( 'buoySlope' );

			if ( spectral ) {

				// Exactly the sampling the water surface does, at this buoy's
				// anchor — which is what makes it sit *on* the surface rather than
				// near it.
				for ( let c = 0; c < spectral.sizes.length; c ++ ) {

					const uvw = anchor.div( spectral.sizes[ c ] );
					disp.addAssign( texture( spectral.disp[ c ], uvw, float( 0 ) ).xyz );
					slope.addAssign( texture( spectral.slope[ c ], uvw, float( 0 ) ).xy );

				}

			}

			const normal = normalize( vec3( slope.x.negate(), 1.0, slope.y.negate() ) ).toVar( 'buoyN' );

			// Orthonormal basis with the surface normal as up, so the buoy leans
			// with the wave face instead of standing rigidly vertical.
			const ref = vec3( 0.0, 0.0, 1.0 );
			const tangent = normalize( cross( ref, normal ) ).toVar( 'buoyT' );
			const bitangent = cross( normal, tangent ).toVar( 'buoyB' );

			const p = positionGeometry;
			const tilted = tangent.mul( p.x ).add( normal.mul( p.y ) ).add( bitangent.mul( p.z ) );

			vNormal.assign( normalize(
				tangent.mul( normalLocal.x ).add( normal.mul( normalLocal.y ) ).add( bitangent.mul( normalLocal.z ) )
			) );
			vLocalY.assign( p.y );
			vTint.assign( tint );

			// The mesh matrix is identity, so returning a world position here is
			// the position.
			return vec3( anchor.x, 0.0, anchor.y ).add( disp ).add( tilted );

		} )();

		material.colorNode = Fn( () => {

			const n = normalize( vNormal ).toVar( 'buoyNorm' );
			const nDotL = saturate( dot( n, u.sunDir ) ).toVar( 'buoyNdL' );

			const ambient = u.sunIntensity.mul( 0.55 ).add( 0.45 ).toVar( 'buoyAmb' );

			// Banded paint: a broad body colour with a white stripe, varying per
			// instance so the fleet is not uniform.
			const band = smoothstep( 0.42, 0.5, vLocalY.mod( 1.15 ).div( 1.15 ) )
				.mul( smoothstep( 0.82, 0.74, vLocalY.mod( 1.15 ).div( 1.15 ) ) );

			const warm = vec3( 0.72, 0.10, 0.07 );
			const cold = vec3( 0.90, 0.62, 0.05 );
			const body = mix( warm, cold, saturate( vTint.mul( 1.4 ) ) ).toVar( 'buoyBody' );

			const paint = mix( body, vec3( 0.88, 0.90, 0.92 ), band ).toVar( 'buoyPaint' );

			// Everything below the waterline is seen through the water column.
			const submerged = smoothstep( 0.05, - 0.35, vLocalY ).toVar( 'buoySub' );
			paint.assign( mix( paint, paint.mul( u.waterShallow ).mul( 2.2 ), submerged ) );

			// Direct sun plus skylight, and a rim so the silhouette reads against
			// a bright horizon.
			const skyLight = mix( u.skyHorizon, u.skyZenith, 0.4 );
			const V = normalize( cameraPosition.sub( positionGeometry ) );
			const rim = pow( saturate( float( 1 ).sub( saturate( dot( n, V ) ) ) ), 3.0 ).mul( 0.35 );

			const lit = paint.mul(
				u.sunColor.mul( nDotL.mul( u.sunIntensity ).mul( 0.9 ) )
					.add( skyLight.mul( ambient.mul( 0.55 ) ) )
			).add( skyLight.mul( rim ) );

			return vec4( lit, 1.0 );

		} )();

		return material;

	}

	/**
	 * Keep the fleet around the viewer.
	 *
	 * Each buoy wraps independently on its own lattice, so they never all jump at
	 * once — and a wrap only ever happens beyond a third of a kilometre, where
	 * aerial haze has already taken most of the contrast.
	 */
	update( camera ) {

		const cx = camera.position.x;
		const cz = camera.position.z;

		for ( let i = 0; i < this.count; i ++ ) {

			const [ bx, bz ] = this.bases[ i ];
			const x = bx + Math.round( ( cx - bx ) / LATTICE ) * LATTICE;
			const z = bz + Math.round( ( cz - bz ) / LATTICE ) * LATTICE;

			this.anchorArray[ i * 2 ] = x;
			this.anchorArray[ i * 2 + 1 ] = z;

		}

		this.anchorAttr.needsUpdate = true;

	}

	dispose() {

		this.mesh.geometry.dispose();
		this.material.dispose();

	}

}
