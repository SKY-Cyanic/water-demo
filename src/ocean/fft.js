// Batched 2D inverse FFT on the GPU, in WebGPU compute.
//
// Algorithm: Stockham autosort, radix 2. Stockham is chosen over Cooley-Tukey
// because it needs no bit-reversal permutation pass — each stage reads from one
// buffer and writes the next in natural order, so the whole transform is
// log2(N) ping-pong dispatches per axis and nothing else.
//
// One stage, for butterfly i of a length-N line:
//
//     m  = 2^s            mh = m/2          half = N/2
//     j  = i mod mh       grp = i div mh
//     w  = exp(sign * 2*pi*i * j / m)
//     dst[grp*m + j]      = src[i] + w * src[i + half]
//     dst[grp*m + j + mh] = src[i] - w * src[i + half]
//
// (The usual src index grp*mh + j simplifies to i exactly, since
//  (i div mh)*mh + (i mod mh) == i.)
//
// Every field of every cascade is transformed by the same dispatch: the thread
// index decomposes into (cascade, field, line, butterfly), so the entire ocean
// costs 2*log2(N) dispatches per frame regardless of how many cascades there
// are.
//
// Index arithmetic is done in float with floor() rather than in integer types.
// Every index here is far below 2^24, so float is exact, and it sidesteps any
// question about how integer division and modulo lower on each backend. The
// numerical verification in tools/qa.mjs is what actually proves it correct.

import { Fn, float, floor, instanceIndex, int, cos, sin, uniform, vec2 } from 'three/tsl';
import { attributeArray } from 'three/tsl';
import { TAU } from '../core/util.js';

export class BatchedFFT {

	/**
	 * @param {number} N        transform size per axis (power of two)
	 * @param {number} planes   how many independent complex fields to transform
	 *                          (cascades * fields per cascade)
	 */
	constructor( N, planes ) {

		this.N = N;
		this.planes = planes;
		this.stages = Math.log2( N );

		if ( ! Number.isInteger( this.stages ) ) {

			throw new Error( `BatchedFFT: N must be a power of two, got ${N}` );

		}

		const elements = planes * N * N;

		// Ping-pong pair. Stockham writes to the opposite buffer every stage, so
		// after an even number of stages the data is back in the buffer it
		// started in — which is why each axis runs an even log2(N) here (256 ->
		// 8 stages) and the caller can rely on the result landing in `a`.
		this.a = attributeArray( elements, 'vec2' );
		this.b = attributeArray( elements, 'vec2' );
		this.a.setName( 'fftA' );
		this.b.setName( 'fftB' );

		// Per-dispatch parameters. Computed on the CPU so the kernel needs no
		// shifts and no loop.
		this.uM = uniform( 2, 'float' );
		this.uMh = uniform( 1, 'float' );
		this.uAxis = uniform( 0, 'float' );   // 0 = along x, 1 = along z
		this.uSign = uniform( 1, 'float' );   // +1 inverse, -1 forward

		this.threads = planes * N * ( N / 2 );

		// Two kernels: a -> b and b -> a.
		this.kernelAB = this._buildKernel( this.a, this.b );
		this.kernelBA = this._buildKernel( this.b, this.a );

	}

	_buildKernel( src, dst ) {

		const N = this.N;
		const half = N / 2;

		return Fn( () => {

			const idx = float( instanceIndex ).toVar( 'fftIdx' );

			const i = idx.mod( half ).toVar( 'fftI' );
			const rest = floor( idx.div( half ) ).toVar( 'fftRest' );
			const line = rest.mod( N ).toVar( 'fftLine' );
			const plane = floor( rest.div( N ) ).toVar( 'fftPlane' );

			const planeBase = plane.mul( N * N ).toVar( 'fftBase' );

			// Element k of this 1D line, as a linear address in the plane.
			//   axis 0: the line is a row  -> (line, k) -> line*N + k
			//   axis 1: the line is a col  -> (k, line) -> k*N + line
			const rowMode = float( 1 ).sub( this.uAxis );
			const addr = ( k ) => planeBase
				.add( rowMode.mul( line.mul( N ).add( k ) ) )
				.add( this.uAxis.mul( k.mul( N ).add( line ) ) );

			const j = i.mod( this.uMh ).toVar( 'fftJ' );
			const grp = floor( i.div( this.uMh ) ).toVar( 'fftGrp' );

			const o0 = grp.mul( this.uM ).add( j ).toVar( 'fftO0' );
			const o1 = o0.add( this.uMh ).toVar( 'fftO1' );

			const z0 = src.element( int( addr( i ) ) ).toVar( 'fftZ0' );
			const z1 = src.element( int( addr( i.add( half ) ) ) ).toVar( 'fftZ1' );

			const angle = this.uSign.mul( TAU ).mul( j ).div( this.uM ).toVar( 'fftAngle' );
			const wr = cos( angle ).toVar( 'fftWr' );
			const wi = sin( angle ).toVar( 'fftWi' );

			// w * z1
			const tr = wr.mul( z1.x ).sub( wi.mul( z1.y ) ).toVar( 'fftTr' );
			const ti = wr.mul( z1.y ).add( wi.mul( z1.x ) ).toVar( 'fftTi' );

			dst.element( int( addr( o0 ) ) ).assign( vec2( z0.x.add( tr ), z0.y.add( ti ) ) );
			dst.element( int( addr( o1 ) ) ).assign( vec2( z0.x.sub( tr ), z0.y.sub( ti ) ) );

		} )().compute( this.threads );

	}

	/**
	 * Run a full 2D transform. Data starts in `this.a`; the result lands in
	 * `this.result`.
	 *
	 * @param {Renderer} renderer
	 * @param {number} sign  +1 for the inverse transform, -1 for the forward one
	 */
	run( renderer, sign = 1 ) {

		this.uSign.value = sign;

		// The ping-pong toggle has to run continuously across both axes, not
		// restart per axis. Restarting it is correct only when log2(N) happens to
		// be even — at N=256 (8 stages) everything lines up and the bug is
		// invisible, while at N=128 (7 stages) the second axis silently re-reads
		// the stale buffer. The N=8 case in tools/qa.mjs exists to catch exactly
		// this.
		let src = 0;

		for ( let axis = 0; axis < 2; axis ++ ) {

			this.uAxis.value = axis;

			for ( let s = 1; s <= this.stages; s ++ ) {

				const m = 1 << s;
				this.uM.value = m;
				this.uMh.value = m >> 1;

				renderer.compute( src === 0 ? this.kernelAB : this.kernelBA );
				src = 1 - src;

			}

		}

		// 2*log2(N) stages is always even, so this is always `a` — but recording
		// it keeps the caller honest if the stage count ever changes.
		this.result = src === 0 ? this.a : this.b;

		return this.result;

	}

	dispose() {

		this.a.dispose?.();
		this.b.dispose?.();

	}

}
