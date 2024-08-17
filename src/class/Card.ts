import { NostrEvent } from '@nostr-dev-kit/ndk';
import { Wallet } from '../exports/index.js';
import { buildDonationEvent, calculateDelta, createCardConfigEvent } from '../lib/cards.js';
import {
  CardLimitParams,
  CardMetadataParams,
  CardStatus,
  type CardPayload,
  type Design,
  type Limit,
} from '../types/Card.js';

interface CardData {
  uuid: string;
  design: Design;
  name: string;
  description: string;
  status: string;
  limits: Limit[];
}

export class Card {
  private _wallet: Wallet;
  private _cardData: CardData;

  constructor(wallet: Wallet, uuid: string, cardDesign: Design, cardConfig: CardPayload) {
    const { name, description, status, limits } = cardConfig;
    this._wallet = wallet;

    this._cardData = {
      uuid,
      design: cardDesign,
      name,
      description,
      status,
      limits,
    };
  }

  async enable() {
    if (this.enabled) throw new Error('The card is already enabled');

    let newCardData: CardData = { ...this._cardData, status: CardStatus.ENABLED };
    return this.broadcastConfig(newCardData);
  }

  async disable() {
    if (!this.enabled) throw new Error('The card is already disabled');

    let newCardData: CardData = { ...this._cardData, status: CardStatus.DISABLED };
    return this.broadcastConfig(newCardData);
  }

  async setMetadata(metadata: CardMetadataParams) {
    let newCardData = {
      ...this._cardData,
      name: metadata.name ?? this._cardData.name,
      description: metadata.description ?? this._cardData.description,
    };

    return this.broadcastConfig(newCardData);
  }

  async replaceLimits(limits: Limit[]) {
    let newCardData = { ...this._cardData, limits };
    return this.broadcastConfig(newCardData);
  }

  async addLimit(params: CardLimitParams) {
    const { tokenId, limitAmount, limitType, limitTime = 0 } = params;

    let name = `${limitType} limit`;
    let description =
      limitType === 'transaction'
        ? `${limitAmount} per ${limitType}`
        : `${limitAmount} every ${limitTime} ${limitType}`;

    let delta = calculateDelta(limitType, limitTime);

    let limitsWithoutDup = this._cardData.limits.filter((limit) => limit.delta !== delta);

    limitsWithoutDup.push({
      name,
      description,
      token: tokenId,
      amount: BigInt(limitAmount).toString(),
      delta,
    });

    return this.replaceLimits(limitsWithoutDup);
  }

  async restartLimits() {
    return this.replaceLimits([]);
  }

  async createTransferEvent() {
    const donationEvent: NostrEvent | undefined = await buildDonationEvent(this);
    if (!donationEvent) return;

    return donationEvent;
  }

  async broadcastConfig(newCardData: CardData) {
    let oldCardData = { ...this._cardData };
    this._cardData = newCardData;

    try {
      let cardConfigEvent = await createCardConfigEvent(this);
      if (!cardConfigEvent) throw new Error();

      return this._wallet.federation.httpPublish(cardConfigEvent);
    } catch {
      this._cardData = oldCardData;
      return false;
    }
  }

  get wallet() {
    return this._wallet;
  }

  get uuid() {
    return this._cardData.uuid;
  }

  get design() {
    return this._cardData.design;
  }

  get name() {
    return this._cardData.name;
  }

  get description() {
    return this._cardData.description;
  }

  get enabled() {
    return this._cardData.status === 'ENABLED';
  }

  get limits(): Limit[] {
    if (!this._cardData.limits) return [];
    return this._cardData.limits;
  }
}
