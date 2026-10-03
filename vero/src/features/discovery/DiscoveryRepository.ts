/**
 * Contact discovery: opt-in settings, phone verification and the private
 * address-book match (see hashing.ts for the protocol).
 */

import { Platform } from 'react-native';
import { supabase } from '../../core/network/supabase';
import { normalizePhone, CountryCode, DEFAULT_COUNTRY } from './normalize';
import { AddressBookContact, batchPrefixes, buildLookupPlan, DiscoveredFriend, LookupRow, matchLookupResults } from './hashing';

export interface DiscoverabilityStatus {
  discoverableByEmail: boolean;
  discoverableByPhone: boolean;
  /** true once a hash is actually listed (opted in AND verified) */
  emailListed: boolean;
  phoneListed: boolean;
  emailVerified: boolean;
  phoneVerified: boolean;
  /** last digits of the verified phone ("•••3210"), if any */
  phoneHint: string | null;
}

function toStatus(row: any): DiscoverabilityStatus {
  return {
    discoverableByEmail: !!row?.discoverable_by_email,
    discoverableByPhone: !!row?.discoverable_by_phone,
    emailListed: !!row?.email_listed,
    phoneListed: !!row?.phone_listed,
    emailVerified: !!row?.email_verified,
    phoneVerified: !!row?.phone_verified,
    phoneHint: row?.phone_hint ?? null,
  };
}

export class ContactsUnavailableError extends Error {
  constructor(message = 'Contacts are only available in the Vero mobile app.') {
    super(message);
    this.name = 'ContactsUnavailableError';
  }
}

export class ContactsPermissionError extends Error {
  constructor(public readonly canAskAgain: boolean) {
    super('Vero was not given access to your contacts.');
    this.name = 'ContactsPermissionError';
  }
}

class DiscoveryRepository {
  async getStatus(): Promise<DiscoverabilityStatus> {
    const { data, error } = await supabase.rpc('get_discoverability');
    if (error) throw error;
    return toStatus(Array.isArray(data) ? data[0] : data);
  }

  async setDiscoverable(byEmail: boolean, byPhone: boolean): Promise<DiscoverabilityStatus> {
    const { data, error } = await supabase.rpc('set_discoverability', { p_by_email: byEmail, p_by_phone: byPhone });
    if (error) throw error;
    return toStatus(Array.isArray(data) ? data[0] : data);
  }

  /**
   * Sends an SMS code to `rawPhone` to attach it to the account.
   * Requires a phone (SMS) provider to be enabled in Supabase Auth.
   */
  async startPhoneVerification(rawPhone: string, country: CountryCode = DEFAULT_COUNTRY): Promise<string> {
    const phone = normalizePhone(rawPhone, country);
    if (!phone) throw new Error('Enter a valid mobile number, e.g. +91 98765 43210.');
    const { error } = await supabase.auth.updateUser({ phone });
    if (error) {
      if (/provider|sms|phone.*(disabled|not enabled)|unsupported/i.test(error.message)) {
        throw new Error(
          'Phone verification is not enabled on this Vero server yet (an SMS provider must be configured). ' +
            'You can still be found by your email.'
        );
      }
      throw error;
    }
    return phone;
  }

  async confirmPhoneVerification(phone: string, code: string): Promise<void> {
    const token = code.replace(/\D/g, '');
    if (token.length < 4) throw new Error('Enter the code from the SMS.');
    const { error } = await supabase.auth.verifyOtp({ phone, token, type: 'phone_change' });
    if (error) throw error;
  }

  /** Reads the device address book (native only). */
  async readAddressBook(): Promise<AddressBookContact[]> {
    if (Platform.OS === 'web') throw new ContactsUnavailableError();
    const Contacts = await import('expo-contacts/legacy');
    if (!(await Contacts.isAvailableAsync())) throw new ContactsUnavailableError();
    const perm = await Contacts.requestPermissionsAsync();
    if (perm.status !== 'granted') throw new ContactsPermissionError(perm.canAskAgain);

    const out: AddressBookContact[] = [];
    let pageOffset = 0;
    const pageSize = 500;
    for (;;) {
      const page = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers, Contacts.Fields.Emails],
        pageSize,
        pageOffset,
      });
      for (const c of page.data) {
        const phones = (c.phoneNumbers ?? []).map((p) => p.number || p.digits || '').filter(Boolean);
        const emails = (c.emails ?? []).map((e) => e.email || '').filter(Boolean);
        if (!phones.length && !emails.length) continue;
        out.push({ id: String(c.id ?? `${out.length}`), name: c.name || phones[0] || emails[0], phones, emails });
      }
      if (!page.hasNextPage || page.data.length === 0) break;
      pageOffset += page.data.length;
    }
    return out;
  }

  /**
   * Finds which address-book entries are on Vero. Only short hash prefixes
   * leave the device; matching happens here.
   */
  async findFriends(
    contacts: AddressBookContact[],
    opts: { defaultCountry?: CountryCode; myEmail?: string | null; onProgress?: (done: number, total: number) => void } = {}
  ): Promise<{ friends: DiscoveredFriend[]; checked: number; prefixesSent: number }> {
    const plan = buildLookupPlan(contacts, {
      defaultCountry: opts.defaultCountry,
      exclude: { emails: opts.myEmail ? [opts.myEmail] : [] },
    });
    const batches = batchPrefixes(plan.prefixes);
    const rows: LookupRow[] = [];
    for (let i = 0; i < batches.length; i++) {
      const { data, error } = await supabase.rpc('discovery_lookup', { p_prefixes: batches[i] });
      if (error) {
        if ((error as any).code === 'PT429' || /rate limit/i.test(error.message)) {
          throw new Error('You have checked your contacts too often today. Try again tomorrow.');
        }
        throw error;
      }
      rows.push(...((data as LookupRow[]) ?? []));
      opts.onProgress?.(i + 1, batches.length);
    }
    return { friends: matchLookupResults(plan, rows), checked: plan.byHash.size, prefixesSent: plan.prefixes.length };
  }
}

export const discoveryRepository = new DiscoveryRepository();
