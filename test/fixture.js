let nextId = 1;
const id = () => `1:${nextId++}`;
const bb = (x, y, width, height) => ({ absoluteBoundingBox: { x, y, width, height } });
const WHITE = { type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } };
const BLUE = { type: 'SOLID', color: { r: 0, g: 0, b: 1, a: 1 } };

export const text = (name, characters, fontSize = 16) => ({
  id: id(), type: 'TEXT', name, characters, ...bb(0, 0, 100, 20), fills: [BLUE],
  style: { fontFamily: 'Inter', fontWeight: 400, fontSize, lineHeightPx: 20, textAutoResize: 'WIDTH_AND_HEIGHT' },
  layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG',
});

export const auto = (name, layoutMode, children, extra = {}) => ({
  id: id(), type: 'FRAME', name, layoutMode, children, ...bb(0, 0, 400, 100), itemSpacing: 8,
  layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'HUG', fills: [WHITE], ...extra,
});

export const image = (name, imageRef) => ({
  id: id(), type: 'RECTANGLE', name, ...bb(0, 0, 50, 50), fills: [{ type: 'IMAGE', imageRef }], layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED',
});

export const vector = (name) => ({ id: id(), type: 'VECTOR', name, ...bb(0, 0, 24, 24), fills: [BLUE] });

export const card = (title, ref) => auto('Card', 'VERTICAL', [image('Photo', ref), text('Title', title)], { paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16, cornerRadius: 8 });

export const landing = () => auto('Landing Page', 'VERTICAL', [
  auto('Header', 'HORIZONTAL', [vector('Logo'), text('Greeting', 'Hi {name} <b> @x `y` \\z'), auto('Primary Button', 'HORIZONTAL', [text('Label', 'Buy')])], { primaryAxisAlignItems: 'SPACE_BETWEEN', counterAxisAlignItems: 'CENTER' }),
  auto('Cards', 'HORIZONTAL', [card('One', 'aaa'), card('Two', 'bbb'), card('Three', 'ccc')]),
  { id: id(), type: 'FRAME', name: '../../evil', ...bb(0, 0, 200, 200), children: [{ ...text('A', 'Absolute'), absoluteBoundingBox: { x: 10, y: 20, width: 50, height: 20 } }, text('B', 'Second'), text('C', 'Third')] },
  { ...text('Hidden', 'nope'), visible: false },
], { absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 900 } });

export const flat = (count) => auto('Flat', 'VERTICAL', [auto('Sect', 'VERTICAL', Array.from({ length: count }, (_, i) => text(`T${i}`, `Row ${i}`)))]);

export const design = (document) => ({ name: 'File', version: '7', document, styles: {}, rawBytes: 1 });
