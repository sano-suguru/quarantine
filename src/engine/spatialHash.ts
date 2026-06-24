export class SpatialHash {
  cell: number;
  map: Map<string, number[]>;

  constructor(cell: number) {
    this.cell = cell;
    this.map = new Map();
  }

  clear(): void {
    this.map.clear();
  }

  insert(i: number, x: number, y: number): void {
    const k = `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`;
    let a = this.map.get(k);
    if (!a) {
      a = [];
      this.map.set(k, a);
    }
    a.push(i);
  }

  query(x: number, y: number, r: number, cb: (i: number) => void): void {
    const c = this.cell;
    const x0 = Math.floor((x - r) / c);
    const x1 = Math.floor((x + r) / c);
    const y0 = Math.floor((y - r) / c);
    const y1 = Math.floor((y + r) / c);
    for (let cx = x0; cx <= x1; cx++)
      for (let cy = y0; cy <= y1; cy++) {
        const a = this.map.get(`${cx},${cy}`);
        if (a) for (let i = 0; i < a.length; i++) cb(a[i] as number);
      }
  }
}
