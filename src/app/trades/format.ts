import { Pipe, PipeTransform } from '@angular/core';

const usdFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const ctFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

@Pipe({ name: 'usd' })
export class UsdPipe implements PipeTransform {
  transform(value: number | null | undefined, signed = false): string {
    if (value == null) return '—';
    const text = usdFormat.format(value);
    return signed && value > 0 ? `+${text}` : text;
  }
}

@Pipe({ name: 'pct' })
export class PctPipe implements PipeTransform {
  transform(value: number | null | undefined, signed = false): string {
    if (value == null) return '—';
    const text = `${value.toFixed(1)}%`;
    return signed && value > 0 ? `+${text}` : text;
  }
}

@Pipe({ name: 'ct' })
export class CtTimePipe implements PipeTransform {
  transform(iso: string | null): string {
    return iso ? `${ctFormat.format(new Date(iso))} CT` : '—';
  }
}
