const MAX_ALIGNMENT_TOKENS = 180;
const FAST_WINDOW_PADDING = 96;
const ANCHOR_LENGTHS = [7, 6, 5, 4];

function normalizeToken(token) {
	const normalized = token
		.normalize('NFKC')
		.toLocaleLowerCase('de-DE')
		.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
	return normalized === '' ? token.toLocaleLowerCase('de-DE') : normalized;
}

function tokenize(text) {
	const tokens = [];
	const matcher = /\S+/gu;
	let match;
	while ((match = matcher.exec(text)) !== null) {
		tokens.push({
			raw: match[0],
			normalized: normalizeToken(match[0]),
			start: match.index,
			end: match.index + match[0].length
		});
	}
	return tokens;
}

function tokenRangeKey(tokens, start, length) {
	let key = '';
	for (let index = start; index < start + length; index += 1) {
		if (index > start) {
			key += '\u0001';
		}
		key += tokens[index].normalized;
	}
	return key;
}

function buildTokenRangeIndex(tokens, length) {
	const positionsByKey = new Map();
	for (let start = 0; start + length <= tokens.length; start += 1) {
		const key = tokenRangeKey(tokens, start, length);
		const positions = positionsByKey.get(key) || [];
		positions.push(start);
		positionsByKey.set(key, positions);
	}
	return positionsByKey;
}

function findAnchor(slowTokens, fastTokens, desiredSlowStart) {
	const searchEnd = Math.min(slowTokens.length, desiredSlowStart + 58);
	for (const length of ANCHOR_LENGTHS) {
		const fastPositionsByKey = buildTokenRangeIndex(fastTokens, length);
		let best = null;
		for (let slowStart = desiredSlowStart; slowStart + length <= searchEnd; slowStart += 1) {
			const slowKey = tokenRangeKey(slowTokens, slowStart, length);
			const matchingFastStarts = fastPositionsByKey.get(slowKey);
			if (!matchingFastStarts) {
				continue;
			}
			const expectedFastStart = Math.max(0, fastTokens.length - (slowTokens.length - slowStart));
			for (const fastStart of matchingFastStarts) {
				const score = Math.abs(fastStart - expectedFastStart) + ((slowStart - desiredSlowStart) * 0.15);
				if (best === null || score < best.score) {
					best = { score, slowEnd: slowStart + length, fastEnd: fastStart + length };
				}
			}
		}
		if (best !== null) {
			return best;
		}
	}
	return null;
}

function chooseAlignmentWindow(slowTokens, fastTokens) {
	if (slowTokens.length <= MAX_ALIGNMENT_TOKENS) {
		return { slowStart: 0, fastStart: 0 };
	}
	const desiredSlowStart = slowTokens.length - MAX_ALIGNMENT_TOKENS;
	const anchor = findAnchor(slowTokens, fastTokens, desiredSlowStart);
	if (anchor !== null) {
		return { slowStart: anchor.slowEnd, fastStart: anchor.fastEnd };
	}
	const slowStart = desiredSlowStart;
	const slowWindowLength = slowTokens.length - slowStart;
	return {
		slowStart,
		fastStart: Math.max(0, fastTokens.length - slowWindowLength - FAST_WINDOW_PADDING)
	};
}

function alignSlowProgressToFastPrefix(slowTokens, fastTokens) {
	const slowLength = slowTokens.length;
	const fastLength = fastTokens.length;
	if (slowLength === 0) {
		return 0;
	}
	let previous = new Uint16Array(fastLength + 1);
	let current = new Uint16Array(fastLength + 1);
	for (let fastIndex = 0; fastIndex <= fastLength; fastIndex += 1) {
		previous[fastIndex] = fastIndex * 2;
	}
	for (let slowIndex = 1; slowIndex <= slowLength; slowIndex += 1) {
		current[0] = slowIndex * 2;
		for (let fastIndex = 1; fastIndex <= fastLength; fastIndex += 1) {
			const substitutionCost = slowTokens[slowIndex - 1] === fastTokens[fastIndex - 1] ? 0 : 2;
			const deleteFromSlow = previous[fastIndex] + 2;
			const insertFromFast = current[fastIndex - 1] + 2;
			const substitute = previous[fastIndex - 1] + substitutionCost;
			current[fastIndex] = Math.min(deleteFromSlow, insertFromFast, substitute);
		}
		const swap = previous;
		previous = current;
		current = swap;
	}
	let bestFastIndex = 0;
	let bestCost = previous[0];
	for (let fastIndex = 1; fastIndex <= fastLength; fastIndex += 1) {
		const cost = previous[fastIndex];
		if (cost < bestCost || (cost === bestCost && fastIndex > bestFastIndex)) {
			bestCost = cost;
			bestFastIndex = fastIndex;
		}
	}
	return bestFastIndex;
}

function completePartialSlowToken(slowText, slowTokens, fastTokens, tailTokenIndex) {
	if (/\s$/u.test(slowText) || slowTokens.length === 0 || tailTokenIndex === 0) {
		return slowText;
	}
	const slowToken = slowTokens[slowTokens.length - 1];
	const fastToken = fastTokens[tailTokenIndex - 1];
	if (!fastToken || !/[\p{L}\p{N}]$/u.test(slowToken.raw)) {
		return slowText;
	}
	const slowWord = slowToken.normalized;
	const fastWord = fastToken.normalized;
	const missingCharacters = fastWord.length - slowWord.length;
	const completionRatio = fastWord.length === 0 ? 0 : slowWord.length / fastWord.length;
	if (slowWord.length < 3 || missingCharacters < 2 || missingCharacters > 6 || completionRatio < 0.55 || !fastWord.startsWith(slowWord)) {
		return slowText;
	}
	return slowText.slice(0, slowToken.start) + fastToken.raw;
}

function sliceTailFromToken(text, tokens, tokenIndex) {
	if (tokenIndex >= tokens.length) {
		return '';
	}
	if (tokenIndex === 0) {
		return text;
	}
	return text.slice(tokens[tokenIndex - 1].end);
}

function countLineBreaks(whitespace) {
	const matches = whitespace.match(/\r\n|\r|\n/gu);
	return matches ? matches.length : 0;
}

function chooseBoundaryWhitespace(slowWhitespace, fastWhitespace) {
	return countLineBreaks(fastWhitespace) > countLineBreaks(slowWhitespace) ? fastWhitespace : slowWhitespace;
}

function joinTranscriptParts(slowText, fastTail) {
	if (fastTail === '') {
		return slowText;
	}
	if (slowText === '') {
		return fastTail;
	}
	const slowMatch = slowText.match(/\s+$/u);
	const fastMatch = fastTail.match(/^\s+/u);
	const slowWhitespace = slowMatch ? slowMatch[0] : '';
	const fastWhitespace = fastMatch ? fastMatch[0] : '';
	if (slowWhitespace !== '' && fastWhitespace !== '') {
		return slowText.slice(0, -slowWhitespace.length)
			+ chooseBoundaryWhitespace(slowWhitespace, fastWhitespace)
			+ fastTail.slice(fastWhitespace.length);
	}
	if (slowWhitespace !== '' || fastWhitespace !== '') {
		return slowText + fastTail;
	}
	if (/^[,.;:!?%)\]}]/u.test(fastTail) || /[(\[{]$/u.test(slowText)) {
		return slowText + fastTail;
	}
	return `${slowText} ${fastTail}`;
}

export function mergeTranscripts(fastText, slowText, slowFinal) {
	if (slowFinal) {
		return slowText;
	}
	if (slowText === '') {
		return fastText;
	}
	if (fastText === '') {
		return slowText;
	}
	const fastTokens = tokenize(fastText);
	const slowTokens = tokenize(slowText);
	if (slowTokens.length === 0) {
		return fastText;
	}
	if (fastTokens.length === 0) {
		return slowText;
	}
	const windowRange = chooseAlignmentWindow(slowTokens, fastTokens);
	const slowSuffix = slowTokens.slice(windowRange.slowStart).map((token) => token.normalized);
	const fastSuffix = fastTokens.slice(windowRange.fastStart).map((token) => token.normalized);
	const consumedFastTokens = alignSlowProgressToFastPrefix(slowSuffix, fastSuffix);
	const tailTokenIndex = Math.min(fastTokens.length, windowRange.fastStart + consumedFastTokens);
	const completedSlowText = completePartialSlowToken(slowText, slowTokens, fastTokens, tailTokenIndex);
	const fastTail = sliceTailFromToken(fastText, fastTokens, tailTokenIndex);
	return joinTranscriptParts(completedSlowText, fastTail);
}

function vocabularyKey(value) {
	return String(value || '')
		.normalize('NFKD')
		.toLocaleLowerCase('de-DE')
		.replace(/\p{M}+/gu, '')
		.replace(/ß/gu, 'ss')
		.replace(/[^\p{L}\p{N}]+/gu, '');
}

function vocabularySpeechKey(value) {
	return vocabularyKey(value)
		.replace(/tsch/gu, 'c')
		.replace(/sch/gu, 's')
		.replace(/sh/gu, 's')
		.replace(/ch/gu, 'x')
		.replace(/ph/gu, 'f')
		.replace(/ck/gu, 'k')
		.replace(/qu/gu, 'kv')
		.replace(/x/gu, 'ks')
		.replace(/z/gu, 'ts')
		.replace(/v/gu, 'f')
		.replace(/w/gu, 'v')
		.replace(/y/gu, 'i')
		.replace(/[aeiou]+/gu, 'a')
		.replace(/(.)\1+/gu, '$1');
}

function boundedEditDistance(left, right, limit) {
	if (left === right) {
		return 0;
	}
	if (Math.abs(left.length - right.length) > limit) {
		return limit + 1;
	}
	let previous = new Uint16Array(right.length + 1);
	let current = new Uint16Array(right.length + 1);
	for (let rightIndex = 0; rightIndex <= right.length; rightIndex += 1) {
		previous[rightIndex] = rightIndex;
	}
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
		current[0] = leftIndex;
		let rowMinimum = current[0];
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
			const substitution = previous[rightIndex - 1] + (left.charAt(leftIndex - 1) === right.charAt(rightIndex - 1) ? 0 : 1);
			const insertion = current[rightIndex - 1] + 1;
			const deletion = previous[rightIndex] + 1;
			current[rightIndex] = Math.min(substitution, insertion, deletion);
			rowMinimum = Math.min(rowMinimum, current[rightIndex]);
		}
		if (rowMinimum > limit) {
			return limit + 1;
		}
		const swap = previous;
		previous = current;
		current = swap;
	}
	return previous[right.length];
}

function vocabularyWords(text) {
	const words = [];
	const matcher = /[\p{L}\p{N}]+/gu;
	let match;
	while ((match = matcher.exec(text)) !== null) {
		words.push({
			start: match.index,
			end: match.index + match[0].length,
			text: match[0]
		});
	}
	return words;
}

export class VocabularyNormalizer {
	constructor(terms) {
		this.entries = [];
		this.maxWindowTokens = 1;
		const seenKeys = Object.create(null);
		(terms || []).forEach((term) => {
			const canonical = String(term || '').trim();
			const key = vocabularyKey(canonical);
			if (!canonical || !key || seenKeys[key]) {
				return;
			}
			seenKeys[key] = true;
			const words = vocabularyWords(canonical);
			const windowTokens = Math.max(words.length, key.length <= 6 ? key.length : Math.min(4, words.length + 2));
			this.maxWindowTokens = Math.min(6, Math.max(this.maxWindowTokens, windowTokens));
			this.entries.push({
				canonical,
				key,
				speechKey: vocabularySpeechKey(canonical)
			});
		});
	}

	score(candidateKey, candidateSpeechKey, entry) {
		if (candidateKey === entry.key) {
			return 0;
		}
		const longest = Math.max(candidateKey.length, entry.key.length);
		const shortest = Math.min(candidateKey.length, entry.key.length);
		if (shortest < 4) {
			return null;
		}
		const limit = longest >= 12 ? 3 : (longest >= 9 ? 2 : 1);
		const phoneticMatch = candidateSpeechKey !== '' && candidateSpeechKey === entry.speechKey;
		const distanceLimit = phoneticMatch ? limit + 1 : limit;
		if (Math.abs(candidateKey.length - entry.key.length) > distanceLimit) {
			return null;
		}
		const distance = boundedEditDistance(candidateKey, entry.key, distanceLimit);
		if (distance > distanceLimit) {
			return null;
		}
		const ratio = distance / longest;
		if ((!phoneticMatch && ratio > 0.22) || (phoneticMatch && ratio > 0.34)) {
			return null;
		}
		return 20 + (ratio * 100) - (phoneticMatch ? 10 : 0);
	}

	matchWindow(text, words, startIndex, endIndex) {
		for (let cursor = startIndex; cursor < endIndex; cursor += 1) {
			const separator = text.slice(words[cursor].end, words[cursor + 1].start);
			if (!/^[\s.\-_/]*$/u.test(separator)) {
				return null;
			}
		}
		const candidate = text.slice(words[startIndex].start, words[endIndex].end);
		const candidateKey = vocabularyKey(candidate);
		const candidateSpeechKey = vocabularySpeechKey(candidate);
		if (!candidateKey) {
			return null;
		}
		let best = null;
		let secondBestScore = Number.POSITIVE_INFINITY;
		this.entries.forEach((entry) => {
			const score = this.score(candidateKey, candidateSpeechKey, entry);
			if (score === null) {
				return;
			}
			if (best === null || score < best.score) {
				secondBestScore = best === null ? Number.POSITIVE_INFINITY : best.score;
				best = {
					canonical: entry.canonical,
					score,
					endIndex,
					exact: score === 0
				};
			} else if (entry.canonical !== best.canonical) {
				secondBestScore = Math.min(secondBestScore, score);
			}
		});
		if (best === null) {
			return null;
		}
		if (!best.exact && secondBestScore - best.score < 8) {
			return null;
		}
		return best;
	}

	findMatch(text, words, startIndex) {
		let best = null;
		const maxEnd = Math.min(words.length - 1, startIndex + this.maxWindowTokens - 1);
		for (let endIndex = startIndex; endIndex <= maxEnd; endIndex += 1) {
			const match = this.matchWindow(text, words, startIndex, endIndex);
			if (match === null) {
				continue;
			}
			if (best === null || match.score < best.score || (match.score === best.score && match.endIndex > best.endIndex)) {
				best = match;
			}
		}
		return best;
	}

	apply(text) {
		if (!text || this.entries.length === 0) {
			return text;
		}
		const words = vocabularyWords(text);
		if (words.length === 0) {
			return text;
		}
		let output = '';
		let cursor = 0;
		let index = 0;
		while (index < words.length) {
			const match = this.findMatch(text, words, index);
			if (match === null) {
				index += 1;
				continue;
			}
			output += text.slice(cursor, words[index].start) + match.canonical;
			cursor = words[match.endIndex].end;
			index = match.endIndex + 1;
		}
		return output + text.slice(cursor);
	}
}

export class TranscriptState {
	constructor(vocabulary, onChange) {
		this.fast = '';
		this.slow = '';
		this.slowFinal = false;
		this.normalizer = new VocabularyNormalizer(vocabulary);
		this.onChange = onChange;
	}

	fastDelta(text) {
		this.fast += text;
		this.onChange(this.getText());
	}

	slowDelta(text) {
		this.slow += text;
		this.onChange(this.getText());
	}

	fastFinal(text) {
		this.fast = text;
		this.onChange(this.getText());
	}

	slowFinalText(text) {
		this.slow = text;
		this.slowFinal = true;
		this.onChange(this.getText());
	}

	getText() {
		return this.normalizer.apply(mergeTranscripts(this.fast, this.slow, this.slowFinal));
	}
}

export function needsDictationSpace(left, right) {
	if (!left || !right) {
		return false;
	}
	const leftChar = left.charAt(left.length - 1);
	const rightChar = right.charAt(0);
	if (/\s/u.test(leftChar) || /\s/u.test(rightChar)) {
		return false;
	}
	if (/[(\[{„‚«‹/]/u.test(leftChar)) {
		return false;
	}
	if (/[,.;:!?%)\]}“’»›/]/u.test(rightChar)) {
		return false;
	}
	return true;
}
