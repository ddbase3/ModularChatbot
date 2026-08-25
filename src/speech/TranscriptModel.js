const TRAILING_WHITESPACE = /\s$/u;
const LEADING_WHITESPACE = /^\s/u;
const OPENING_CHARACTER = /[([{„«]$/u;
const CLOSING_CHARACTER = /^[.,!?;:%)\]}”»’]/u;

export function boundarySeparator(left, right) {
	if (left === '' || right === '') {
		return '';
	}

	if (TRAILING_WHITESPACE.test(left) || LEADING_WHITESPACE.test(right)) {
		return '';
	}

	if (OPENING_CHARACTER.test(left) || CLOSING_CHARACTER.test(right)) {
		return '';
	}

	const leftCharacter = left.charAt(left.length - 1);
	const rightCharacter = right.charAt(0);

	if (leftCharacter === '-' || rightCharacter === '-' || leftCharacter === '/' || rightCharacter === '/') {
		return '';
	}

	return ' ';
}

export function joinTranscriptParts(parts) {
	let transcript = '';

	for (const part of parts) {
		if (typeof part !== 'string') {
			continue;
		}

		const text = part.trim();

		if (text === '') {
			continue;
		}

		transcript += boundarySeparator(transcript, text) + text;
	}

	return transcript;
}

export class TranscriptModel {
	constructor(sourceText, selectionStart, selectionEnd) {
		this.sourceText = typeof sourceText === 'string' ? sourceText : '';
		this.selectionStart = this.clampSelection(selectionStart);
		this.selectionEnd = Math.max(this.selectionStart, this.clampSelection(selectionEnd));
		this.prefix = this.sourceText.slice(0, this.selectionStart);
		this.suffix = this.sourceText.slice(this.selectionEnd);
		this.items = new Map();
		this.sequence = 0;
	}

	registerItem(itemId, previousItemId) {
		if (typeof itemId !== 'string' || itemId === '') {
			return null;
		}

		let item = this.items.get(itemId);

		if (!item) {
			item = {
				id: itemId,
				sequence: this.sequence,
				partialText: '',
				finalText: '',
				completed: false,
				failed: false,
				hasPreviousItem: false,
				previousItemId: null,
			};
			this.sequence += 1;
			this.items.set(itemId, item);
		}

		if (previousItemId !== undefined) {
			item.hasPreviousItem = true;
			item.previousItemId = typeof previousItemId === 'string' && previousItemId !== ''
				? previousItemId
				: null;
		}

		return item;
	}

	appendDelta(itemId, delta) {
		if (typeof delta !== 'string' || delta === '') {
			return;
		}

		const item = this.registerItem(itemId);

		if (!item || item.completed) {
			return;
		}

		item.partialText += delta;
	}

	completeItem(itemId, transcript) {
		const item = this.registerItem(itemId);

		if (!item) {
			return;
		}

		item.finalText = typeof transcript === 'string' ? transcript : '';
		item.completed = true;
		item.failed = false;
	}

	failItem(itemId) {
		const item = this.registerItem(itemId);

		if (!item) {
			return;
		}

		item.finalText = item.partialText;
		item.completed = true;
		item.failed = true;
	}

	get itemCount() {
		return this.items.size;
	}

	get hasPendingItems() {
		for (const item of this.items.values()) {
			if (!item.completed) {
				return true;
			}
		}

		return false;
	}

	getSpeechText() {
		const parts = this.getItemsInOrder().map((item) => item.completed
			? item.finalText
			: item.partialText);

		return joinTranscriptParts(parts);
	}

	compose() {
		const speechText = this.getSpeechText();

		if (speechText === '') {
			return {
				value: this.sourceText,
				speechStart: this.selectionStart,
				speechEnd: this.selectionEnd,
				caret: this.selectionEnd,
				hasSpeech: false,
			};
		}

		const leftSeparator = boundarySeparator(this.prefix, speechText);
		const speechStart = this.prefix.length + leftSeparator.length;
		let value = this.prefix + leftSeparator + speechText;
		const speechEnd = value.length;
		value += boundarySeparator(value, this.suffix) + this.suffix;

		return {
			value,
			speechStart,
			speechEnd,
			caret: speechEnd,
			hasSpeech: true,
		};
	}

	getItemsInOrder() {
		const items = Array.from(this.items.values()).sort((left, right) => left.sequence - right.sequence);
		const children = new Map();
		const roots = [];

		for (const item of items) {
			if (
				item.hasPreviousItem
				&& item.previousItemId !== null
				&& this.items.has(item.previousItemId)
			) {
				const siblings = children.get(item.previousItemId) ?? [];
				siblings.push(item);
				children.set(item.previousItemId, siblings);
				continue;
			}

			roots.push(item);
		}

		const ordered = [];
		const visited = new Set();
		const visit = (item) => {
			if (visited.has(item.id)) {
				return;
			}

			visited.add(item.id);
			ordered.push(item);

			const descendants = children.get(item.id) ?? [];
			descendants.sort((left, right) => left.sequence - right.sequence);

			for (const descendant of descendants) {
				visit(descendant);
			}
		};

		for (const root of roots) {
			visit(root);
		}

		for (const item of items) {
			visit(item);
		}

		return ordered;
	}

	clampSelection(value) {
		if (!Number.isInteger(value)) {
			return this.sourceText.length;
		}

		return Math.max(0, Math.min(value, this.sourceText.length));
	}
}
