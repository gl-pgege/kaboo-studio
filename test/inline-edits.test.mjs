import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editImage, editText, placeOf } from '../dist/engine/editor/inline-edits.js';

const HERO = `export function Hero({ product }) {
  return (
    <section>
      <h1 className="text-display">
        Made in small runs
      </h1>
      <p>{product.name}</p>
      <p>Tom&apos;s pick</p>
      <Picture src="" alt="" />
      <img src={'/media/old.jpg'} alt="Old" />
    </section>
  );
}
`;

test('a place reads file, line and column', () => {
  assert.deepEqual(placeOf('app/blocks/Hero.tsx:4:7'), { file: 'app/blocks/Hero.tsx', line: 4, column: 7 });
  assert.throws(() => placeOf('../secrets.tsx:1:1'), /Pick the element/);
});

test('static text is replaced in place, keeping its layout', () => {
  const next = editText(placeOf('app/blocks/Hero.tsx:4:7'), HERO, 'Made in small runs', 'Built to last');
  assert.match(next, /<h1 className="text-display">\n {8}Built to last\n {6}<\/h1>/);
  assert.equal(next.replace('Built to last', 'Made in small runs'), HERO);
});

test('text that comes from data says so', () => {
  assert.throws(() => editText(placeOf('app/blocks/Hero.tsx:7:7'), HERO, 'Tee', 'Shirt'), /comes from the store's data/);
});

test('entities compare as shown, and braces stay safe', () => {
  const next = editText(placeOf('app/blocks/Hero.tsx:8:7'), HERO, "Tom's pick", 'Picks {for} you');
  assert.match(next, /<p>\{"Picks \{for\} you"\}<\/p>/);
});

test('text that changed since it was picked is refused', () => {
  assert.throws(() => editText(placeOf('app/blocks/Hero.tsx:4:7'), HERO, 'Something else', 'New'), /changed since you picked it/);
});

test('a literal picture source is replaced with the chosen asset', () => {
  const empty = editImage(placeOf('app/blocks/Hero.tsx:9:7'), HERO, '', '/assets/preview/ab/tee__preview.jpg');
  assert.match(empty, /<Picture src="\/assets\/preview\/ab\/tee__preview.jpg" alt="" \/>/);
  const old = editImage(placeOf('app/blocks/Hero.tsx:10:7'), HERO, '/media/old.jpg', 'http://localhost:3101/assets/preview/cd/new.jpg');
  assert.match(old, /<img src=\{"http:\/\/localhost:3101\/assets\/preview\/cd\/new.jpg"\} alt="Old" \/>/);
  assert.throws(() => editImage(placeOf('app/blocks/Hero.tsx:9:7'), HERO, '', 'javascript:alert(1)'), /Assets/);
});
