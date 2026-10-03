/**
 * Normalisation of address-book identifiers before hashing.
 *
 * Must produce exactly what the server hashes for discoverable users
 * (supabase/migrations/009: lower(btrim(email)) and "+" || digits of the
 * verified phone), otherwise contacts never match.
 */

export type CountryCode = 'IN' | 'US' | 'CA' | 'GB' | 'AE' | 'SG' | 'AU' | 'DE' | 'FR' | 'NP' | 'BD' | 'PK' | 'LK';

export const DEFAULT_COUNTRY: CountryCode = 'IN';

interface CountryRule {
  /** International calling code (digits). */
  cc: string;
  /** Allowed lengths of the national significant number. */
  nsnLengths: number[];
  /** Domestic trunk prefix dropped when dialling internationally. */
  trunk?: string;
}

const COUNTRIES: Record<CountryCode, CountryRule> = {
  IN: { cc: '91', nsnLengths: [10], trunk: '0' },
  US: { cc: '1', nsnLengths: [10], trunk: '1' },
  CA: { cc: '1', nsnLengths: [10], trunk: '1' },
  GB: { cc: '44', nsnLengths: [9, 10], trunk: '0' },
  AE: { cc: '971', nsnLengths: [8, 9], trunk: '0' },
  SG: { cc: '65', nsnLengths: [8] },
  AU: { cc: '61', nsnLengths: [9], trunk: '0' },
  DE: { cc: '49', nsnLengths: [6, 7, 8, 9, 10, 11], trunk: '0' },
  FR: { cc: '33', nsnLengths: [9], trunk: '0' },
  NP: { cc: '977', nsnLengths: [8, 9, 10], trunk: '0' },
  BD: { cc: '880', nsnLengths: [10], trunk: '0' },
  PK: { cc: '92', nsnLengths: [9, 10], trunk: '0' },
  LK: { cc: '94', nsnLengths: [9], trunk: '0' },
};

const E164_DIGITS = /^[1-9]\d{7,14}$/;

/** Lower-cased, trimmed email, or null if it does not look like an address. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

/** Applies country-specific sanity checks to an E.164 digit string. */
function plausible(digits: string): boolean {
  if (!E164_DIGITS.test(digits)) return false;
  // India: +91 followed by exactly 10 digits.
  if (digits.startsWith('91') && digits.length !== 12) return false;
  return true;
}

/**
 * Converts a phone number as typed in an address book into E.164
 * ("+<country code><number>"), assuming `defaultCountry` for numbers written
 * without an international prefix. Returns null for anything that isn't a
 * plausible phone number (short codes, extensions only, garbage).
 *
 * India examples (default country IN):
 *   "98765 43210", "098765-43210", "+91 98765 43210", "0091 9876543210",
 *   "919876543210", "+91 (0) 98765 43210"  ->  "+919876543210"
 */
export function normalizePhone(raw: string | null | undefined, defaultCountry: CountryCode = DEFAULT_COUNTRY): string | null {
  if (!raw) return null;
  // Drop extensions ("x123", "ext. 4", ";4", ",4").
  const main = raw.split(/(?:e?xt\.?|x|;|,|#)/i)[0].trim();
  if (!main) return null;
  if (/[a-wyz]/i.test(main)) return null; // letters (vanity numbers etc.)

  const hasPlus = main.startsWith('+');
  let digits = main.replace(/\D/g, '');
  if (!digits) return null;

  const rule = COUNTRIES[defaultCountry];

  if (hasPlus || digits.startsWith('00')) {
    if (!hasPlus) digits = digits.slice(2);
    // "+91 (0) 98765 43210" / "+44 (0)20 ..." - drop a trunk 0 after the country code.
    for (const r of Object.values(COUNTRIES)) {
      if (r.trunk === '0' && digits.startsWith(r.cc + '0') && r.nsnLengths.includes(digits.length - r.cc.length - 1)) {
        digits = r.cc + digits.slice(r.cc.length + 1);
        break;
      }
    }
    return plausible(digits) ? `+${digits}` : null;
  }

  // National format: strip trunk prefix, prepend the default country code.
  let nsn = digits;
  if (rule.nsnLengths.includes(nsn.length)) {
    return plausible(rule.cc + nsn) ? `+${rule.cc}${nsn}` : null;
  }
  if (rule.trunk && nsn.startsWith(rule.trunk) && rule.nsnLengths.includes(nsn.length - rule.trunk.length)) {
    nsn = nsn.slice(rule.trunk.length);
    return plausible(rule.cc + nsn) ? `+${rule.cc}${nsn}` : null;
  }
  // Country code written without "+" (e.g. "919876543210").
  if (nsn.startsWith(rule.cc) && rule.nsnLengths.includes(nsn.length - rule.cc.length)) {
    return plausible(nsn) ? `+${nsn}` : null;
  }
  return null;
}
