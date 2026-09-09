/**
 * What the conversion actually held, as a running maximum.
 *
 * A memory budget is a claim, and a claim wants checking. Everything the claim
 * covers already knows its own high-water mark — a page cache tracks the most
 * it ever held, a read window has a capacity it cannot exceed, a `ValueMeter`
 * remembers the largest string it saw — so this does not measure anything. It
 * collects those numbers, adds them up the way `planBudget` divided them, and
 * reports the total.
 *
 * ## Why not just read the process's memory
 *
 * Because `process.memoryUsage().rss` is dominated by Node itself. On a small
 * conversion the runtime is a hundred and forty megabytes and the converter is
 * four hundred kilobytes, so RSS cannot distinguish a budget being honoured
 * from a budget being ignored. RSS is worth watching for a trend across sizes,
 * which is what the benchmark does; it is useless as an assertion, which is
 * what this is for.
 *
 * ## Bounded, like everything else here
 *
 * Every registration is a reference to something that already exists, and
 * every reading is arithmetic over a fixed number of them: three stores, one
 * window, one meter. Nothing accumulates per page, per note or per value, so
 * turning this on costs a few pointers and cannot itself breach the budget it
 * is checking.
 */
import { reserveFor, ValueMeter } from './limits';

/** One reading of everything the budget covers. */
export interface ResidentReading {
	/** The most any store's page cache ever held, summed across the stores. */
	cacheHighWaterBytes: number;
	/** The read window's capacity, which is also its ceiling. */
	windowBytes: number;
	/** Buffers allocated once and never grown: spills, spool chunks, the note buffer. */
	fixedBytes: number;
	/** Bytes the budget set aside for values that cannot be streamed. */
	valueReserveBytes: number;
	/** Bytes the largest values actually seen would need — at most the reserve. */
	valueObservedBytes: number;
	/**
	 * The largest record any store handed to a caller.
	 *
	 * `get` returns a copy, so every read out of a store is an allocation the
	 * caller holds. This is the largest one seen, against the several pages
	 * the budget reserves for the ones held at once.
	 */
	recordCopyBytes: number;
	/**
	 * The claim: everything the budget covers, at its worst moment.
	 *
	 * The reserve is counted rather than the observation, because the reserve
	 * is what the conversion is entitled to spend and a hostile file would
	 * spend it. `valueObservedBytes` is beside it so the two can be compared.
	 */
	highWaterBytes: number;
	/** What was asked for, if anything was. */
	budgetBytes?: number;
	/** Caches registered, so a reading over the wrong number is noticeable. */
	caches: number;
}

/**
 * A place to register the things a budget covers, and read the total back.
 *
 * Registration is idempotent by identity: registering the same store twice
 * counts it once, so a caller does not have to track what it has already
 * handed over.
 */
export class ResidentAccount {
	/**
	 * Caches that live as long as the run: the batch's workspace store.
	 *
	 * Keyed by the thing that owns the cache, so registering it twice counts
	 * it once and a caller need not remember what it has handed over.
	 */
	readonly #caches = new Map<object, () => number>();

	/** Stores to ask about the record copies they handed out. */
	readonly #copies = new Map<object, () => number>();

	/**
	 * Caches that live as long as one section, kept apart from the others.
	 *
	 * A section's stores close when it does, and reading a closed store's
	 * counters is not allowed — so these are dropped at each section boundary
	 * while the run-long ones stay. Keeping them in one map and clearing it
	 * would take the workspace store with them, which is how this was wrong
	 * the first time.
	 */
	readonly #sectionCaches = new Map<object, () => number>();

	#windowBytes = 0;
	#meter: ValueMeter | undefined;
	#fixedBytes = 0;
	#valueReserveBytes = 0;
	#budgetBytes: number | undefined;
	#peakHighWaterBytes = 0;
	#recordCopyBytes = 0;

	/**
	 * The parts a budget fixes up front, which no measurement can change.
	 *
	 * Taken from the plan rather than from the components, because these are
	 * allocations sized once at construction: reading them back from the
	 * objects would only re-derive what the plan already said.
	 */
	declare(fixedBytes: number, valueReserveBytes: number, budgetBytes?: number): void {
		this.#fixedBytes = fixedBytes;
		this.#valueReserveBytes = valueReserveBytes;
		this.#budgetBytes = budgetBytes;
	}

	/**
	 * A cache to include, named by its owner and read through a getter.
	 *
	 * A getter rather than the number, because the number changes; the owner
	 * rather than the getter as the key, because two getters over the same
	 * cache are not two caches.
	 */
	addCache(owner: object, highWaterBytes: () => number): void {
		this.#caches.set(owner, highWaterBytes);
	}

	/** A cache belonging to the section being converted, dropped by `release`. */
	addSectionCache(owner: object, highWaterBytes: () => number): void {
		this.#sectionCaches.set(owner, highWaterBytes);
	}

	/**
	 * A store to ask about the record copies it hands out.
	 *
	 * Kept apart from the caches because the two are different allocations
	 * with different reserves, and because the largest copy a section made is
	 * worth keeping after that section has closed — it is a maximum, not a
	 * quantity that goes away.
	 */
	addCopies(owner: object, copyHighWaterBytes: () => number): void {
		this.#copies.set(owner, copyHighWaterBytes);
	}

	/**
	 * The window's size, of which there is one.
	 *
	 * One section is open at a time, so a later window replaces an earlier one
	 * rather than adding to it — and they are the same size anyway, both being
	 * the size the budget named.
	 */
	setWindowBytes(bytes: number): void {
		this.#windowBytes = bytes;
	}

	setMeter(meter: ValueMeter): void {
		this.#meter = meter;
	}

	get meter(): ValueMeter | undefined {
		return this.#meter;
	}

	/**
	 * A reading now, and a record of the highest one taken.
	 *
	 * A store's cache high water survives the store being closed only if it is
	 * read first, so a caller converting several sections should read between
	 * them — `peakHighWaterBytes` is what remembers those readings.
	 */
	read(): ResidentReading {
		let cacheHighWaterBytes = 0;
		for (const highWater of this.#caches.values()) cacheHighWaterBytes += highWater();
		for (const highWater of this.#sectionCaches.values()) cacheHighWaterBytes += highWater();

		let recordCopyBytes = this.#recordCopyBytes;
		for (const copy of this.#copies.values()) {
			recordCopyBytes = Math.max(recordCopyBytes, copy());
		}
		this.#recordCopyBytes = recordCopyBytes;

		const windowBytes = this.#windowBytes;
		const valueObservedBytes = this.#meter?.reservedBytesUsed ?? 0;
		const highWaterBytes = cacheHighWaterBytes + windowBytes
			+ this.#fixedBytes + this.#valueReserveBytes;

		if (highWaterBytes > this.#peakHighWaterBytes) this.#peakHighWaterBytes = highWaterBytes;

		return {
			cacheHighWaterBytes,
			windowBytes,
			fixedBytes: this.#fixedBytes,
			valueReserveBytes: this.#valueReserveBytes,
			valueObservedBytes,
			recordCopyBytes,
			highWaterBytes,
			budgetBytes: this.#budgetBytes,
			caches: this.#caches.size + this.#sectionCaches.size,
		};
	}

	/** The highest total any `read` has seen, including readings since closed. */
	get peakHighWaterBytes(): number {
		return Math.max(this.#peakHighWaterBytes, this.read().highWaterBytes);
	}

	/**
	 * Forget the section's caches, keeping the peak.
	 *
	 * Called at a section boundary so that a closed store is not read again,
	 * while the high water it reached still counts towards the peak. The
	 * window and the meter stay, since the next section replaces them, and the
	 * run-long caches stay because the run is not over.
	 */
	release(): void {
		void this.read();
		this.#sectionCaches.clear();
		this.#copies.clear();
	}
}

/** Bytes the worst simultaneous set of values needs at these sizes. */
export { reserveFor };
