import assert from 'node:assert/strict';
import test from 'node:test';
import {
	TranscriptModel,
	boundarySeparator,
	joinTranscriptParts
} from '../src/speech/TranscriptModel.js';

test('inserts a live transcript and replaces it with the final correction', () => {
	const model = new TranscriptModel('', 0, 0);

	model.registerItem('item-1', null);
	model.appendDelta('item-1', 'Bitte prüfe Müll');
	assert.equal(model.compose().value, 'Bitte prüfe Müll');

	model.completeItem('item-1', 'Bitte prüfe Müller Maschinen.');
	assert.equal(model.compose().value, 'Bitte prüfe Müller Maschinen.');
});

test('replaces the selected range without changing the surrounding text', () => {
	const source = 'Hallo alter Text danke.';
	const start = source.indexOf('alter');
	const end = start + 'alter Text'.length;
	const model = new TranscriptModel(source, start, end);

	model.appendDelta('item-1', 'Peter, bitte prüfen');

	assert.equal(model.compose().value, 'Hallo Peter, bitte prüfen danke.');
});

test('orders final transcripts by item references instead of completion order', () => {
	const model = new TranscriptModel('', 0, 0);

	model.registerItem('item-2', 'item-1');
	model.completeItem('item-2', 'Zweiter Satz.');
	model.registerItem('item-1', null);
	model.completeItem('item-1', 'Erster Satz.');

	assert.equal(model.compose().value, 'Erster Satz. Zweiter Satz.');
});

test('keeps a partial transcript when OpenAI marks one item as failed', () => {
	const model = new TranscriptModel('', 0, 0);

	model.appendDelta('item-1', 'Bereits sichtbarer Text');
	model.failItem('item-1');

	assert.equal(model.compose().value, 'Bereits sichtbarer Text');
	assert.equal(model.hasPendingItems, false);
});

test('joins punctuation and word boundaries naturally', () => {
	assert.equal(boundarySeparator('Hallo', 'Peter'), ' ');
	assert.equal(boundarySeparator('Hallo ', 'Peter'), '');
	assert.equal(boundarySeparator('Hallo', ','), '');
	assert.equal(boundarySeparator('(', 'Test'), '');
	assert.equal(joinTranscriptParts(['Hallo', ',', 'wie geht es dir?']), 'Hallo, wie geht es dir?');
});
