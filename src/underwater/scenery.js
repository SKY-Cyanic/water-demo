// Things that only exist below the surface: the seabed and suspended particles.
//
// Both follow the camera so they are always present where the viewer is, and
// both are procedural — no textures, no models.

import { AdditiveBlending, BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshBasicNodeMaterial, PlaneGeometry, Points, PointsNodeMaterial } from 'three/webgpu';
import {
	Fn, float, fract, length, mix, mx_fractal_noise_float, oneMinus, positionGeometry,
	positionWorld, saturate, smoothstep, uniform, uv, vec3, vec4,
} from 'three/tsl';

import { causticPattern } from '../ocean/shading.js';
import { mulberry32 } from '../core/util.js';

/**
 * Procedural sandy bottom.
 *
 * A single large plane that follows the camera in XZ. Its height comes from
 * layered noise (dunes plus ripples), and the sun's caustic web is projected
 * onto it — which is what actually sells "shallow water" more than the sand
 * colour does.
 */
export class Seabed {

	constructor( env ) {

		this.env = env;
		const u = env.u;

		const material = new MeshBasicNodeMaterial();
		material.name = 'Seabed';
		material.side = DoubleSide;
		material.fog = false;

		const EXTENT = 900;

		// PlaneGeometry lies in local XY with z = 0, and the mesh is rotated -90
		// degrees about X. That rotation maps local (x, y, z) -> world (x, z, -y),
		// so the plane's own coordinates are .xy (not .xz), and raising a vertex in
		// world Y means pushing local Z *negative*.
		material.positionNode = Fn( () => {

			const p = positionGeometry.xy.add( u.seabedOrigin ).toVar( 'bedP' );

			const dunes = mx_fractal_noise_float( vec3( p.mul( 0.012 ), 0.0 ), 3, 2.0, 0.5 ).mul( 1.6 );
			const ripples = mx_fractal_noise_float( vec3( p.mul( 0.22 ), 0.0 ), 2, 2.0, 0.5 ).mul( 0.09 );

			return vec3( positionGeometry.x, positionGeometry.y, dunes.add( ripples ).negate() );

		} )();

		material.colorNode = Fn( () => {

			const p = positionWorld.xz.toVar( 'bedWorld' );

			const grain = mx_fractal_noise_float( vec3( p.mul( 0.75 ), 0.0 ), 3, 2.0, 0.55 ).mul( 0.5 ).add( 0.5 );
			const patch = mx_fractal_noise_float( vec3( p.mul( 0.045 ).add( 11.0 ), 0.0 ), 2, 2.0, 0.5 ).mul( 0.5 ).add( 0.5 );

			const sand = u.seabedColor.mul( float( 0.62 ).add( grain.mul( 0.22 ) ).add( patch.mul( 0.28 ) ) ).toVar( 'sand' );

			// Caustics, strongest with a high sun and fading with depth of water
			// above the bed.
			const caustic = causticPattern( p, u.time )
				.mul( u.causticStrength )
				.mul( saturate( u.sunDir.y.mul( 2.0 ) ) )
				.toVar( 'bedCaustic' );

			// Deliberately modest: the caustic web is a *modulation* of the light
			// reaching the bed, not an extra light source. Let it drive the total
			// and the sand blows out to cream before the water column has any
			// chance to tint it.
			const ambient = u.sunIntensity.mul( 0.42 ).add( 0.22 );

			const lit = sand.mul( ambient ).mul( float( 1.0 ).add( caustic.mul( 0.55 ) ) );

			// Fade the rim into the water colour so the plane's edge is never a
			// visible line on the seabed. The underwater pass fogs distance anyway,
			// but at high visibility the geometric edge can still outrun it.
			const r = length( positionGeometry.xy ).toVar( 'bedR' );
			const rim = oneMinus( smoothstep( EXTENT * 0.16, EXTENT * 0.42, r ) );

			return vec4( mix( u.uwTint.mul( ambient ), lit, rim ), 1.0 );

		} )();

		this.mesh = new Mesh( new PlaneGeometry( EXTENT, EXTENT, 160, 160 ), material );
		this.mesh.name = 'Seabed';
		this.mesh.rotation.x = - Math.PI / 2;
		this.mesh.frustumCulled = false;
		this.mesh.matrixAutoUpdate = false;
		this.mesh.visible = false;

	}

	update( camera ) {

		const p = this.env.params;
		const u = this.env.u;

		this.mesh.visible = !! p.seabedEnabled;
		if ( ! this.mesh.visible ) return;

		// Snap so the noise does not crawl as the plane slides.
		const x = Math.round( camera.position.x );
		const z = Math.round( camera.position.z );

		this.mesh.position.set( x, - p.seabedDepth, z );
		this.mesh.rotation.x = - Math.PI / 2;
		this.mesh.updateMatrix();
		this.mesh.updateMatrixWorld( true );

		u.seabedOrigin.value.set( x, z );

	}

	dispose() {

		this.mesh.geometry.dispose();
		this.mesh.material.dispose();

	}

}

/**
 * Suspended particulate.
 *
 * A fixed cloud of points wrapped into a box that follows the camera, so the
 * viewer is always inside it and it never has to be regenerated. Sinking motion
 * plus a slow drift; opacity is what the density slider changes, not the count,
 * so adjusting it never rebuilds a buffer.
 */
export class Particles {

	constructor( env, count = 2600, extent = 34 ) {

		this.env = env;
		this.extent = extent;

		const rnd = mulberry32( 913377 );
		const positions = new Float32Array( count * 3 );
		const seeds = new Float32Array( count );

		for ( let i = 0; i < count; i ++ ) {

			positions[ i * 3 + 0 ] = ( rnd() - 0.5 ) * extent;
			positions[ i * 3 + 1 ] = ( rnd() - 0.5 ) * extent;
			positions[ i * 3 + 2 ] = ( rnd() - 0.5 ) * extent;
			seeds[ i ] = rnd();

		}

		const geometry = new BufferGeometry();
		geometry.setAttribute( 'position', new BufferAttribute( positions, 3 ) );
		geometry.setAttribute( 'pseed', new BufferAttribute( seeds, 1 ) );

		const u = env.u;
		this.uDrift = uniform( vec3( 0, 0, 0 ) );

		const material = new PointsNodeMaterial();
		material.name = 'Particles';
		material.transparent = true;
		material.depthWrite = false;
		material.blending = AdditiveBlending;
		material.sizeAttenuation = true;

		// Wrap into the box: the cloud is centred on the camera, so a particle
		// leaving one face re-enters the opposite one and the field is seamless.
		material.positionNode = Fn( () => {

			const drifted = positionGeometry.add( this.uDrift ).toVar( 'pDrift' );
			const wrapped = fract( drifted.div( extent ).add( 0.5 ) ).sub( 0.5 ).mul( extent );
			return wrapped;

		} )();

		material.sizeNode = float( 0.055 );

		material.colorNode = Fn( () => {

			// Round, soft-edged sprite. Points are quads; uv() spans them.
			const d = uv().sub( 0.5 ).length().toVar( 'pD' );
			const alpha = oneMinus( smoothstep( 0.16, 0.5, d ) ).toVar( 'pA' );

			// Fade in only underwater, and thin out with depth.
			const amount = u.uwFactor.mul( u.particleDensity ).toVar( 'pAmount' );

			return vec4( u.uwTint.mul( 2.4 ).add( 0.16 ), alpha.mul( amount ).mul( 0.5 ) );

		} )();

		this.points = new Points( geometry, material );
		this.points.name = 'Particles';
		this.points.frustumCulled = false;
		this.points.matrixAutoUpdate = false;
		this.points.visible = false;

		this._t = 0;

	}

	update( camera, dt, underwaterFactor ) {

		this.points.visible = underwaterFactor > 0.01 && this.env.params.particleDensity > 0.001;
		if ( ! this.points.visible ) return;

		this._t += dt;

		// Slow sink plus a lateral drift with the wind-driven current.
		this.uDrift.value.set(
			this.env.windDirJS.x * this._t * 0.12,
			this._t * 0.16,
			this.env.windDirJS.y * this._t * 0.12
		);

		this.points.position.copy( camera.position );
		this.points.updateMatrix();
		this.points.updateMatrixWorld( true );

	}

	dispose() {

		this.points.geometry.dispose();
		this.points.material.dispose();

	}

}
