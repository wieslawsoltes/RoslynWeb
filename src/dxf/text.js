/**
 * Browser-font layout for portable DXF TEXT, ATTRIB and MTEXT entities.
 *
 * axisX/axisY are world-space vectors for ONE nominal text-height unit. They
 * already include text height, rotation, OCS and INSERT transforms. width/height
 * remain the source DXF dimensions, so width / height is a local dimension.
 * Without axes, height and rotation define an ordinary world-XY text basis.
 * Corners follow texture order: top-left, top-right, bottom-right, bottom-left.
 * CAD font programs and MTEXT rich formatting are not reproduced by Canvas2D;
 * any known substitution or unsupported control is returned as an issue.
 */
const DEG = Math.PI / 180;
const GENERIC_FONTS = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded']);
const ALIGNMENTS = new Set(['topleft', 'topcenter', 'topright', 'middleleft', 'middlecenter', 'middleright', 'bottomleft', 'bottomcenter', 'bottomright', 'baselineleft', 'baselinecenter', 'baselineright', 'aligned', 'middle', 'fit']);

function fail(code, message) { const error = new Error(message); error.code = code; return error; }
function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} must be finite.`);
  return value;
}
function positive(value, label) { finite(value, label); if (value <= 0) throw new RangeError(`${label} must be positive.`); return value; }
function point(value, label) {
  if (!value || typeof value !== 'object') throw new TypeError(`${label} is missing.`);
  const p = Array.isArray(value) || ArrayBuffer.isView(value) ? value : [value.x, value.y, value.z];
  return [finite(p[0], `${label}.x`), finite(p[1], `${label}.y`), finite(p[2] ?? 0, `${label}.z`)];
}
function issueCollector(issues) {
  return (code, message) => { if (!issues.some(item => item.code === code && item.message === message)) issues.push({ code, message }); };
}

function legacyControls(text, addIssue) {
  return text.replace(/%%([dpcuok%]|\d{3})/gi, (match, code) => {
    switch (code.toLowerCase()) {
      case 'd': return '\u00b0';
      case 'p': return '\u00b1';
      case 'c': return '\u2300';
      case '%': return '%';
      case 'u': case 'o': case 'k':
        addIssue('DXF_TEXT_INLINE_FORMATTING', 'Underline, overline and strike-through text controls are displayed as undecorated browser text.'); return '';
      default: {
        const value = Number(code);
        if (value > 127) addIssue('DXF_TEXT_LEGACY_CODEPAGE', 'Numeric %% character codes above ASCII are interpreted as Unicode; the original CAD code page may differ.');
        return String.fromCharCode(value);
      }
    }
  });
}

/** Decode common DXF controls while retaining Unicode and reporting lost styling. */
export function normalizeDxfText(entity) {
  if (!entity || typeof entity !== 'object') throw new TypeError('A DXF text entity is required.');
  const type = String(entity.type ?? 'TEXT').toUpperCase();
  if (!['TEXT', 'MTEXT', 'ATTRIB', 'ATTDEF', 'ATTRIBUTE', 'ATTRIBUTEDEFINITION'].includes(type)) throw new TypeError(`Expected a text entity, received ${type}.`);
  if (typeof entity.text !== 'string') throw new TypeError('DXF text must be a string.');
  // Fail explicitly rather than allowing a hostile label to allocate arbitrary
  // layout state or repeatedly shape an unbounded amount of text.
  if (entity.text.length > 100_000) throw fail('DXF_TEXT_LIMIT', 'A DXF text entity exceeds the 100,000-character layout limit.');
  const issues = [], addIssue = issueCollector(issues);
  let value = entity.text.replace(/\r\n?/g, '\n');
  if (type === 'MTEXT') {
    let output = '', depth = 0;
    for (let i = 0; i < value.length; i++) {
      const char = value[i];
      if (char === '{') { depth++; continue; }
      if (char === '}') {
        if (depth) depth--; else addIssue('DXF_TEXT_MALFORMED_FORMATTING', 'MTEXT contains an unmatched formatting brace.');
        continue;
      }
      if (char !== '\\') { output += char; continue; }
      const command = value[++i];
      if (command === undefined) { output += '\\'; addIssue('DXF_TEXT_MALFORMED_FORMATTING', 'MTEXT ends with an incomplete escape.'); break; }
      if (command === '\\' || command === '{' || command === '}') { output += command; continue; }
      if (command === 'P') { output += '\n'; continue; }
      if (command === '~') { output += '\u00a0'; continue; }
      if (command === 'U' && /^\+[\da-f]{4}/i.test(value.slice(i + 1, i + 6))) {
        output += String.fromCharCode(parseInt(value.slice(i + 2, i + 6), 16)); i += 5; continue;
      }
      if ('LlOoKk'.includes(command)) {
        addIssue('DXF_TEXT_INLINE_FORMATTING', 'Underline, overline and strike-through text controls are displayed as undecorated browser text.'); continue;
      }
      if ('AaCcFfHhQqTtWwpSs'.includes(command)) {
        const end = value.indexOf(';', i + 1);
        if (end < 0) {
          output += `\\${command}`;
          addIssue('DXF_TEXT_MALFORMED_FORMATTING', `MTEXT \\${command} control is missing its terminating semicolon.`); continue;
        }
        const argument = value.slice(i + 1, end);
        if (command === 'S' || command === 's') {
          output += argument.replace(/\^\s?/g, '/').replace(/#/g, '/');
          addIssue('DXF_TEXT_STACKED_FRACTION', 'MTEXT stacked fractions are displayed inline with a slash; stacked placement is not supported.');
        } else {
          addIssue('DXF_TEXT_INLINE_FORMATTING', 'MTEXT inline font, color, size, spacing and paragraph formatting are displayed using the entity browser-font style.');
        }
        i = end; continue;
      }
      if (command === 'N' || command === 'X') {
        output += '\n'; addIssue('DXF_TEXT_COLUMNS', 'MTEXT column or extended breaks are displayed as paragraph breaks.'); continue;
      }
      output += `\\${command}`;
      addIssue('DXF_TEXT_UNKNOWN_CONTROL', `MTEXT control \\${command} is not supported and is retained literally.`);
    }
    if (depth) addIssue('DXF_TEXT_MALFORMED_FORMATTING', 'MTEXT contains an unclosed formatting brace.');
    value = output;
  } else {
    value = value.replace(/\\U\+([\da-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    if (value.includes('\n')) {
      value = value.replace(/\n/g, ' ');
      addIssue('DXF_TEXT_MULTILINE', 'Line breaks in single-line TEXT or ATTRIB are displayed as spaces; use MTEXT for paragraphs.');
    }
  }
  value = legacyControls(value, addIssue);
  if (value.includes('%<')) addIssue('DXF_TEXT_FIELD', 'Unevaluated DXF fields are displayed literally; field evaluation is not supported.');
  return { plainText: value, issues };
}

function entitySettings(entity, issues) {
  const addIssue = issueCollector(issues), height = positive(entity.height ?? 1, 'Text height');
  const position = point(entity.position, 'Text position');
  const angle = finite(entity.rotation ?? 0, 'Text rotation') * DEG;
  if (Boolean(entity.axisX) !== Boolean(entity.axisY)) throw new TypeError('Text axisX and axisY must be supplied together.');
  const axisX = entity.axisX ? point(entity.axisX, 'Text axisX') : [Math.cos(angle) * height, Math.sin(angle) * height, 0];
  const axisY = entity.axisY ? point(entity.axisY, 'Text axisY') : [-Math.sin(angle) * height, Math.cos(angle) * height, 0];
  positive(Math.hypot(...axisX), 'Text axisX length'); positive(Math.hypot(...axisY), 'Text axisY length');
  if (Math.hypot(axisX[1]*axisY[2]-axisX[2]*axisY[1], axisX[2]*axisY[0]-axisX[0]*axisY[2], axisX[0]*axisY[1]-axisX[1]*axisY[0]) === 0) throw new RangeError('Text basis axes must span a plane.');
  const widthFactor = positive(entity.widthFactor ?? 1, 'Text width factor');
  const width = finite(entity.width ?? 0, 'Text width');
  if (width < 0) throw new RangeError('Text width must be nonnegative.');
  const obliqueAngle = finite(entity.obliqueAngle ?? 0, 'Text oblique angle');
  if (Math.abs(obliqueAngle) >= 89) throw new RangeError('Text oblique angle must be between -89 and 89 degrees.');
  const lineSpacingFactor = positive(entity.lineSpacingFactor ?? 1, 'Text line spacing factor');
  const type = String(entity.type ?? 'TEXT').toUpperCase();
  const alignment = String(entity.alignment ?? 'BaselineLeft').replace(/[\s_-]/g, '').toLowerCase();
  if (type !== 'MTEXT' && !ALIGNMENTS.has(alignment)) throw new TypeError(`Unknown text alignment ${entity.alignment}.`);
  const attachment = entity.attachmentPoint ?? 1;
  if (type === 'MTEXT' && (!Number.isInteger(attachment) || attachment < 1 || attachment > 9)) throw new RangeError('MTEXT attachmentPoint must be an integer from 1 through 9.');
  if (entity.isVertical) addIssue('DXF_TEXT_VERTICAL_STYLE', 'Vertical CAD text styles are displayed horizontally by the browser-font renderer.');
  if (entity.drawingDirection !== undefined && !['lefttoright', 'bystyle'].includes(String(entity.drawingDirection).replace(/[\s_-]/g, '').toLowerCase())) {
    addIssue('DXF_TEXT_DRAWING_DIRECTION', `MTEXT drawing direction ${entity.drawingDirection} is displayed with horizontal left-to-right paragraph layout; alternate CAD drawing directions are not supported.`);
  }
  if ((alignment === 'fit' || alignment === 'aligned') && width <= 0) throw new RangeError('Fit and Aligned text require a positive width.');
  return { type, height, position, axisX, axisY, width, widthFactor, alignment, attachment, lineSpacingFactor, shear: Math.tan(obliqueAngle * DEG), mirrorX: entity.isBackward ? -1 : 1, mirrorY: entity.isUpsideDown ? -1 : 1 };
}

function canvasFor(factory) {
  let canvas;
  try {
    if (factory) canvas = factory(1, 1);
    else if (typeof OffscreenCanvas === 'function') canvas = new OffscreenCanvas(1, 1);
    else if (typeof document !== 'undefined' && document.createElement) canvas = document.createElement('canvas');
    const context = canvas?.getContext?.('2d');
    if (!context || typeof context.measureText !== 'function' || typeof context.fillText !== 'function') throw new Error('Canvas2D is unavailable.');
    return { canvas, context };
  } catch (cause) {
    const error = fail('DXF_TEXT_CANVAS_UNAVAILABLE', 'DXF text rendering needs a Canvas2D implementation. Supply canvasFactory in hosts without OffscreenCanvas or document.createElement("canvas").');
    error.cause = cause; throw error;
  }
}

function familyCss(family) { return GENERIC_FONTS.has(family.toLowerCase()) ? family : JSON.stringify(family); }
function fontFor(entity, context, fallback, size, addIssue) {
  if (typeof fallback !== 'string' || !fallback.trim()) throw new TypeError('fontFamily must be a nonempty browser font family.');
  let family = typeof entity.fontFamily === 'string' && entity.fontFamily.trim() ? entity.fontFamily.trim() : fallback.trim();
  const fontFile = String(entity.fontFile ?? '');
  const style = String(entity.fontStyle ?? '').toLowerCase();
  const prefix = `${/italic|oblique/.test(style) ? 'italic ' : ''}${/bold/.test(style) ? 'bold ' : ''}${size}px `;
  if (/\.(shx|shp)$/i.test(fontFile) || /\.(shx|shp)$/i.test(family)) {
    addIssue('DXF_TEXT_FONT_SUBSTITUTION', `CAD shape font ${fontFile || family} is unavailable to Canvas2D; ${fallback} is substituted.`);
    family = fallback.trim();
  } else if (!entity.fontFamily && fontFile) {
    addIssue('DXF_TEXT_FONT_SUBSTITUTION', `Font file ${fontFile} has no browser family mapping; ${fallback} is substituted.`);
  }
  if (!GENERIC_FONTS.has(family.toLowerCase())) {
    // FontFaceSet.check alone returns true for some nonexistent installed font
    // names. Compare two fallbacks as well; an absent face matches both.
    const probe = 'mmmmmmmmWWWWWiiiiil0123\u6f22\u5b57';
    const sameAsFallbacks = ['monospace', 'serif'].every(generic => {
      context.font = `${prefix}${generic}`; const baseline = context.measureText(probe).width;
      context.font = `${prefix}${familyCss(family)}, ${generic}`;
      return Math.abs(context.measureText(probe).width - baseline) < 0.01;
    });
    const fontSet = typeof document !== 'undefined' ? document.fonts : undefined;
    if (sameAsFallbacks || (fontSet?.check && !fontSet.check(`${prefix}${familyCss(family)}`, probe))) {
      addIssue('DXF_TEXT_FONT_SUBSTITUTION', `Browser font ${family} is unavailable or not loaded; ${fallback} is substituted. Load the font and rebuild the scene to use it.`);
      family = fallback.trim();
    }
  }
  return `${prefix}${familyCss(family)}`;
}

function graphemes(value) {
  if (typeof Intl?.Segmenter === 'function') return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].map(item => item.segment);
  // Preserve surrogate pairs, combining marks, variation selectors and ZWJ
  // sequences in hosts without Intl.Segmenter.
  const result = [];
  for (const char of value) {
    if (result.length && (/\p{Mark}|[\ufe00-\ufe0f\u200d]/u.test(char) || result.at(-1).endsWith('\u200d'))) result[result.length - 1] += char;
    else result.push(char);
  }
  return result;
}

function wrapText(text, width, measure) {
  if (!(width > 0)) return text.split('\n');
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    const firstLine = lines.length;
    const tokens = paragraph.match(/[ \t]+|[^ \t]+/g) ?? [''];
    for (const token of tokens) {
      if (measure(line + token) <= width) { line += token; continue; }
      if (/^[ \t]+$/.test(token)) { if (line) { lines.push(line.replace(/[ \t]+$/, '')); line = ''; } continue; }
      if (line) { lines.push(line.replace(/[ \t]+$/, '')); line = ''; }
      // A nonbreaking space keeps its containing phrase together, even if it
      // exceeds the reference rectangle. Long ordinary words break at graphemes.
      if (measure(token) <= width || token.includes('\u00a0')) { line = token; continue; }
      for (const cluster of graphemes(token)) {
        if (line && measure(line + cluster) > width) { lines.push(line); line = ''; }
        line += cluster;
      }
    }
    if (line || lines.length === firstLine) lines.push(line);
  }
  return lines;
}

function worldCorners(settings, rect, anchor, unit, scaleX, scaleY) {
  const { position, axisX, axisY, mirrorX, mirrorY, shear } = settings;
  return [[rect.left, rect.top], [rect.right, rect.top], [rect.right, rect.bottom], [rect.left, rect.bottom]].map(([px, py]) => {
    const x = (px - anchor.x) / unit, y = -(py - anchor.y) / unit;
    const u = mirrorX * (scaleX * x + shear * scaleY * y), v = mirrorY * scaleY * y;
    return position.map((p, i) => finite(p + axisX[i] * u + axisY[i] * v, 'Generated text coordinate'));
  });
}

/**
 * Rasterize complete shaped browser-font lines onto transparent white glyphs.
 * Returned width/height are texture pixels; corners retain double-precision world
 * coordinates. Entity color is intentionally applied later by the GPU shader.
 * Large labels are downsampled to maxTextureDimension with an explicit issue.
 */
export function prepareDxfText(entity, { canvasFactory, fontFamily = 'sans-serif', fontSize = 64, maxTextureDimension = 4096 } = {}) {
  positive(fontSize, 'fontSize');
  if (!Number.isSafeInteger(maxTextureDimension) || maxTextureDimension < 1) throw new RangeError('maxTextureDimension must be a positive integer.');
  if (canvasFactory !== undefined && typeof canvasFactory !== 'function') throw new TypeError('canvasFactory must be a function.');
  const { plainText, issues } = normalizeDxfText(entity), addIssue = issueCollector(issues);
  const settings = entitySettings(entity, issues);
  const { canvas, context } = canvasFor(canvasFactory);
  const font = fontFor(entity, context, fontFamily, fontSize, addIssue);
  const configure = () => { context.font = font; context.textBaseline = 'alphabetic'; context.textAlign = 'left'; context.direction = 'ltr'; context.fillStyle = '#ffffff'; };
  configure();
  const cap = context.measureText('H');
  const capHeight = Number.isFinite(cap.actualBoundingBoxAscent) && cap.actualBoundingBoxAscent > 0 ? cap.actualBoundingBoxAscent : fontSize * 0.72;
  // Wrapping repeatedly shapes candidate lines. Bound actual shaping work, not
  // only input length, so an extremely wide paragraph cannot trigger quadratic
  // work with an arbitrarily large token or thousands of short words.
  let measurementWork = 0, measurementCalls = 0;
  const measureMetrics = value => {
    measurementWork += Math.max(1, value.length); measurementCalls++;
    if (measurementWork > 4_000_000 || measurementCalls > 25_000) throw fail('DXF_TEXT_LAYOUT_LIMIT', 'DXF text exceeds the browser-font layout work budget (4,000,000 measured characters or 25,000 measurements).');
    return context.measureText(value);
  };
  const measure = value => Math.max(0, finite(measureMetrics(value).width, 'Measured text width'));
  const referenceWidth = settings.width / settings.height * capHeight / settings.widthFactor;
  const lineValues = settings.type === 'MTEXT' ? wrapText(plainText, referenceWidth, measure) : [plainText];
  // DXF's ordinary baseline spacing is 5/3 of nominal character height.
  const lineStep = capHeight * (5 / 3) * settings.lineSpacingFactor;
  let left = 0, right = 0, top = -capHeight, bottom = 0, logicalWidth = 0;
  const lines = lineValues.map((text, index) => {
    const metrics = measureMetrics(text), width = Math.max(0, finite(metrics.width, 'Measured text width'));
    const baseline = index * lineStep;
    const ascent = Number.isFinite(metrics.actualBoundingBoxAscent) ? Math.max(0, metrics.actualBoundingBoxAscent) : capHeight;
    const descent = Number.isFinite(metrics.actualBoundingBoxDescent) ? Math.max(0, metrics.actualBoundingBoxDescent) : capHeight * 0.25;
    const inkLeft = Number.isFinite(metrics.actualBoundingBoxLeft) ? -metrics.actualBoundingBoxLeft : 0;
    const inkRight = Number.isFinite(metrics.actualBoundingBoxRight) ? metrics.actualBoundingBoxRight : width;
    left = Math.min(left, inkLeft); right = Math.max(right, width, inkRight);
    top = Math.min(top, baseline - ascent); bottom = Math.max(bottom, baseline + descent);
    logicalWidth = Math.max(logicalWidth, width);
    return { text, width, baseline };
  });
  const anchor = { x: 0, y: 0 };
  let scaleX = settings.widthFactor, scaleY = 1;
  if (settings.type === 'MTEXT') {
    const blockWidth = Math.max(logicalWidth, referenceWidth);
    right = Math.max(right, blockWidth);
    anchor.x = ((settings.attachment - 1) % 3) * blockWidth / 2;
    anchor.y = top + Math.floor((settings.attachment - 1) / 3) * (bottom - top) / 2;
  } else {
    if (settings.alignment.endsWith('center') || settings.alignment === 'middle') anchor.x = logicalWidth / 2;
    else if (settings.alignment.endsWith('right')) anchor.x = logicalWidth;
    if (settings.alignment.startsWith('top')) anchor.y = -capHeight;
    else if (settings.alignment.startsWith('bottom')) anchor.y = bottom;
    else if (settings.alignment === 'middle') anchor.y = (top + bottom) / 2;
    else if (settings.alignment.startsWith('middle')) anchor.y = -capHeight / 2;
    if ((settings.alignment === 'fit' || settings.alignment === 'aligned') && logicalWidth > 0) {
      const ratio = referenceWidth / logicalWidth;
      scaleX *= ratio;
      if (settings.alignment === 'aligned') scaleY *= ratio;
    }
  }
  const padding = Math.max(2, fontSize / 32);
  left -= padding; right += padding; top -= padding; bottom += padding;
  const rawWidth = positive(right - left, 'Text raster width'), rawHeight = positive(bottom - top, 'Text raster height');
  const pixelScale = Math.min(1, maxTextureDimension / rawWidth, maxTextureDimension / rawHeight);
  if (pixelScale < 1) addIssue('DXF_TEXT_TEXTURE_DOWNSAMPLED', `Text raster was downsampled to fit the ${maxTextureDimension}-pixel texture limit; geometry and complete text are preserved.`);
  const width = Math.max(1, Math.min(maxTextureDimension, Math.ceil(rawWidth * pixelScale)));
  const height = Math.max(1, Math.min(maxTextureDimension, Math.ceil(rawHeight * pixelScale)));
  canvas.width = width; canvas.height = height;
  configure();
  context.clearRect(0, 0, width, height);
  context.setTransform(pixelScale, 0, 0, pixelScale, -left * pixelScale, -top * pixelScale);
  for (const line of lines) if (line.text) context.fillText(line.text, 0, line.baseline);
  const corners = worldCorners(settings, { left, top, right: left + width / pixelScale, bottom: top + height / pixelScale }, anchor, capHeight, scaleX, scaleY);
  return { canvas, width, height, corners, issues, plainText, lines, font, capHeight, pixelScale };
}

/** Alias for callers treating rasterization and measurement as one layout step. */
export const createDxfTextLayout = prepareDxfText;

/**
 * Canvas-free estimate for CPU scene bounds before browser fonts are available.
 * This deliberately generous box is not a substitute for measured layout. A
 * renderer should include prepareDxfText().corners when fitting its actual text.
 */
export function estimateDxfTextCorners(entity) {
  const { plainText, issues } = normalizeDxfText(entity), settings = entitySettings(entity, issues);
  const paragraphs = plainText.split('\n'), count = Math.max(1, [...plainText].length);
  const reference = settings.width / settings.height / settings.widthFactor;
  const naturalWidth = paragraphs.reduce((maximum, line) => Math.max(maximum, [...line].length * 2), 1);
  const width = Math.max(naturalWidth, reference), height = Math.max(2, count * (5 / 3) * settings.lineSpacingFactor + 2);
  // A symmetric envelope covers all attachment points, baseline/cap alignment,
  // descenders and browser side bearings without assuming installed-font metrics.
  let scaleX = settings.widthFactor, scaleY = 1;
  if (settings.alignment === 'fit' || settings.alignment === 'aligned') {
    scaleX = Math.max(scaleX, settings.width / settings.height);
    if (settings.alignment === 'aligned') scaleY = Math.max(1, settings.width / settings.height * 4);
  }
  return worldCorners(settings, { left: -width, top: -height, right: width, bottom: height }, { x: 0, y: 0 }, 1, scaleX, scaleY);
}
