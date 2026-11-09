// Layer names come from the design file and are untrusted. Everything here returns ASCII alphanumerics.
const words = (s) => String(s).normalize('NFKD').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
const cap = (w) => w[0].toUpperCase() + w.slice(1);

export const slug = (s) => words(s).join('-').toLowerCase();

export function pascal(s) {
  const name = words(s).map(cap).join('') || 'Section';
  return /^\d/.test(name) ? `S${name}` : name;
}

export function camel(s) {
  const name = pascal(s);
  return name[0].toLowerCase() + name.slice(1);
}

export function uniqueNamer(reserved = []) {
  const used = new Set(reserved);
  return (base) => {
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}${i}`;
    used.add(name);
    return name;
  };
}
