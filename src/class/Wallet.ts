import NDK, { NDKEvent, NDKKind, NDKPrivateKeySigner, NDKSigner, NDKTag, NostrEvent } from '@nostr-dev-kit/ndk';
import { getPublicKey, UnsignedEvent } from 'nostr-tools';
import { LaWalletKinds } from '../constants/nostr.js';
import {
  activateCard,
  buildCardActivationEvent,
  buildCardTransferAcceptEvent,
  cardsFilter,
  parseCardsEvents,
} from '../lib/cards.js';
import { buildZapRequestEvent } from '../lib/events.js';
import lightBolt11 from '../lib/light-bolt11.js';
import { createNDKInstance, fetchToNDK } from '../lib/ndk.js';
import {
  buildTxStartEvent,
  encryptMetadataTag,
  executeTransaction,
  formatLNURLData,
  parseTransactionsEvents,
  transactionsFilters,
} from '../lib/transactions.js';
import { createInvoice, nowInSeconds } from '../lib/utils.js';
import { CardsInfo } from '../types/Card.js';
import type { CreateFederationConfigParams } from '../types/Federation.js';
import {
  InternalTransactionParams,
  InvoiceTransactionParams,
  LNURLTransferType,
  SendTransactionParams,
  Transaction,
  TransferTypes,
} from '../types/Transaction.js';
import { Card } from './Card.js';
import { Federation } from './Federation.js';
import { Identity } from './Identity.js';
import { Api } from '../lib/api.js';

type WalletParameters = {
  signer?: NDKPrivateKeySigner; // TODO: Change NDKPrivateKeySigner to signer:NDKSigner
  ndk?: NDK;
  federationConfig?: CreateFederationConfigParams;
};

type ZapParams = {
  receiverPubkey: string;
  milisatoshis: number;
  tags: NDKTag[];
  comment?: string;
};

export class Wallet extends Identity {
  private _signer: NDKSigner;

  constructor(params?: WalletParameters) {
    let signer = params?.signer ?? NDKPrivateKeySigner.generate();
    if (!signer.privateKey) throw new Error('A signer is required to create a wallet instance.');

    try {
      const federation = new Federation(params?.federationConfig);
      const ndk = params?.ndk ?? createNDKInstance(federation.relaysList, signer);

      const pubkey = getPublicKey(signer.privateKey);

      super({ pubkey, ndk, federation, fetchParams: { enabled: true } });

      this._signer = signer;
    } catch (err) {
      console.log(err);
      throw err;
    }
  }

  get signer() {
    return this._signer;
  }

  async getBalance(tokenId: string): Promise<number> {
    if (!this.ndk) throw new Error('No NDK instance found');

    const fnFetch = () =>
      this.ndk.fetchEvent({
        authors: [this.federation.modulePubkeys.ledger],
        kinds: [LaWalletKinds.PARAMETRIZED_REPLACEABLE as unknown as NDKKind],
        '#d': [`balance:${tokenId}:${this.pubkey}`],
      });

    const event = await fetchToNDK<NDKEvent | null>(this.ndk, fnFetch);

    if (!event) {
      return 0;
    }

    return Number(event.getMatchingTags('amount')[0]?.[1]);
  }

  async getTransactions(): Promise<Transaction[]> {
    if (!this.ndk) throw new Error('No NDK instance found');

    const fnFetch = () => {
      let filters = transactionsFilters(this.pubkey, this.federation.modulePubkeys, { limit: 5000 });

      return this.ndk.fetchEvents(filters, {
        closeOnEose: true,
      });
    };

    const transactionEvents = await fetchToNDK<Set<NDKEvent>>(this.ndk, fnFetch);
    return parseTransactionsEvents(this, Array.from(transactionEvents));
  }

  async getCards() {
    if (!this.ndk) throw new Error('No NDK instance found');

    const fnFetch = () => {
      let filters = cardsFilter(this.pubkey, this.federation.modulePubkeys.card);

      return this.ndk.fetchEvents(filters, {
        closeOnEose: true,
      });
    };

    const cardsEvents = await fetchToNDK<Set<NDKEvent>>(this.ndk, fnFetch);
    const cardsInfo: CardsInfo = await parseCardsEvents(this, Array.from(cardsEvents));

    let cards: Card[] = [];

    for (const id in cardsInfo.data) {
      let design = cardsInfo.data[id].design;
      let cardConfig = cardsInfo.config.cards[id];

      cards.push(new Card(this, id, design, cardConfig));
    }

    return cards;
  }

  async createZap(params: ZapParams) {
    if (params.milisatoshis < 1000) throw new Error('The milisatoshis amount must be greater than or equal to 1000');

    const zapRequestEvent: NostrEvent | undefined = await this.signEvent(
      buildZapRequestEvent(
        this.pubkey,
        params.receiverPubkey,
        params.milisatoshis,
        this.federation.relaysList,
        params.tags,
      ),
    );

    const zapRequestURI: string = encodeURI(JSON.stringify(zapRequestEvent));

    const identity = new Identity({ pubkey: params.receiverPubkey });
    const { lnurlpData } = await identity.fetch();

    if (!lnurlpData) throw new Error(`lnurlpData of ${params.receiverPubkey} pubkey not found`);

    return createInvoice({
      callback: lnurlpData.callback,
      milisatoshis: params.milisatoshis,
      nostr: zapRequestURI,
      comment: params.comment,
    });
  }

  async generateInvoice(params: { milisatoshis: number; comment?: string }) {
    let lnurlpData = this.lnurlpData || (await this.fetch()).lnurlpData;
    if (!lnurlpData) throw new Error('lnurlpData not found');

    const { milisatoshis, comment } = params;

    return createInvoice({ callback: lnurlpData.callback, milisatoshis, comment });
  }

  async signEvent(event: Partial<NostrEvent>): Promise<NostrEvent> {
    if (!this.signer) throw new Error('Signer not found');

    try {
      const eventTemplate: UnsignedEvent = {
        kind: 0,
        content: '',
        created_at: nowInSeconds(),
        tags: [],
        pubkey: this.pubkey,
        ...event,
      };

      const ndkEvent: NDKEvent = new NDKEvent(this.ndk, eventTemplate);
      await ndkEvent.sign();

      return ndkEvent.toNostrEvent();
    } catch (err) {
      throw err;
    }
  }

  async sendTransaction(params: SendTransactionParams) {
    if (!this.lnurlpData) await this.fetch();

    const {
      amount: maxAmount,
      lnurlpData,
      type,
      data,
    }: LNURLTransferType = await formatLNURLData(params.receiver, this.federation);
    if (!lnurlpData) throw new Error('Malformed receptor');

    if (
      (maxAmount > 0 && params.amount !== maxAmount) ||
      (lnurlpData.maxSendable && params.amount > lnurlpData.maxSendable)
    )
      throw new Error('The amount is invalid');

    let metadata: { sender?: string; receiver?: string } = {};

    if (data.includes('@')) metadata['receiver'] = data;
    if (this.walias) metadata['sender'] = this.walias;

    switch (type) {
      case TransferTypes.INTERNAL: {
        if (!lnurlpData.accountPubKey) throw new Error('Cannot send internal transfer without accountPubkey');
        if (lnurlpData.accountPubKey === this.pubkey) throw new Error('You cannot send yourself');

        return this.sendInternalTransaction({
          ...params,
          receiver: lnurlpData.accountPubKey,
          metadata,
        });
      }

      case TransferTypes.LUD16 || TransferTypes.LNURL: {
        const { pr: paymentRequest } = await createInvoice({
          callback: lnurlpData.callback,
          milisatoshis: params.amount,
          comment: params.comment,
        });
        if (!paymentRequest) throw new Error('The invoice could not be generated');

        return this.payInvoice({ paymentRequest, metadata, onSuccess: params.onSuccess, onError: params.onError });
      }
    }
  }

  async payInvoice(params: InvoiceTransactionParams) {
    const { paymentRequest, metadata = {}, onSuccess, onError } = params;
    const invoiceInfo = lightBolt11.decode(paymentRequest);

    if (!invoiceInfo || !invoiceInfo.millisatoshis) throw new Error('Malformed payment request');

    if (invoiceInfo.timeExpireDate && Number(invoiceInfo.timeExpireDate) * 1000 < Date.now())
      throw new Error('Payment request expired');

    const metadataTag: NDKTag = await encryptMetadataTag(this.signer, this.federation.modulePubkeys.urlx, metadata);

    const txStartEvent = await this.signEvent(
      buildTxStartEvent({
        tokenId: 'BTC',
        amount: Number(invoiceInfo.millisatoshis),
        senderPubkey: this.pubkey,
        tags: [['p', this.federation.modulePubkeys.urlx], ['bolt11', paymentRequest], metadataTag],
      }),
    );

    if (!txStartEvent) throw new Error('Error on create start event');

    return executeTransaction({
      type: 'external',
      ndk: this.ndk,
      startEvent: txStartEvent,
      federation: this.federation,
      onSuccess,
      onError,
    });
  }

  async sendInternalTransaction(params: InternalTransactionParams) {
    const { tokenId, receiver, amount, comment = '', metadata = {}, onSuccess, onError } = params;

    const metadataTag: NDKTag = await encryptMetadataTag(this.signer, receiver, metadata);

    const txStartEvent = await this.signEvent(
      buildTxStartEvent(
        {
          tokenId,
          amount,
          senderPubkey: this.pubkey,
          comment,
          tags: [['p', receiver], metadataTag],
        },
        this.federation,
      ),
    );

    if (!txStartEvent) throw new Error('Error on create start event');

    return executeTransaction({
      type: 'internal',
      ndk: this.ndk,
      startEvent: txStartEvent,
      federation: this.federation,
      onSuccess,
      onError,
    });
  }

  async claimCardTransfer(donationEvent: NostrEvent) {
    let sk = (this._signer as NDKPrivateKeySigner).privateKey;
    if (!sk) throw new Error('You cannot sign a delegation without a private key');

    const cardAcceptEvent: NostrEvent = await buildCardTransferAcceptEvent(
      donationEvent.pubkey,
      donationEvent,
      sk,
      this.federation,
    );

    return activateCard(cardAcceptEvent, this.federation);
  }

  async addCard(nonce: string) {
    let sk = (this._signer as NDKPrivateKeySigner).privateKey;
    if (!sk) throw new Error('You cannot sign a delegation without a private key');

    const cardActivationEvent: NostrEvent = await buildCardActivationEvent(nonce, sk, this.federation);
    return activateCard(cardActivationEvent, this.federation);
  }
}
