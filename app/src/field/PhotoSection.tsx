import type { PhotoRef, PhotoType } from '../types';
import React from 'react';
import Icon from '../components/Icon';

interface PhotoSectionProps {
  photos: PhotoRef[];
  onCapture: (type: PhotoType) => Promise<void>;
  onRemove: (id: string) => void;
  onDescribe: (id: string, description: string) => void;
  busy: boolean;
  destroyedMode: boolean;
  damageFlags: { rail: boolean; deck: boolean; super: boolean; sub: boolean; washout: boolean };
}

interface SlotConfig {
  type: PhotoType;
  label: string;
  badge: string;
  badgeClass: string;
}

const STANDARD_SLOTS: SlotConfig[] = [
  { type: 'upstation', label: 'Upstation approach photo', badge: 'anytime', badgeClass: 'opt' },
  { type: 'profile', label: 'Bridge profile photo', badge: 'anytime', badgeClass: 'opt' },
  { type: 'downstation', label: 'Downstation approach photo', badge: 'optional', badgeClass: 'opt' },
];

const DESTROYED_SLOTS: SlotConfig[] = [
  { type: 'destroyed_profile', label: 'Bridge profile photo', badge: 'REQ', badgeClass: 'req' },
  {
    type: 'destroyed_approach',
    label:
      'Approach-location photo — stand where the approach was, looking across where the bridge was',
    badge: 'REQ',
    badgeClass: 'req',
  },
];

const DAMAGE_MAP: Array<{ key: keyof PhotoSectionProps['damageFlags']; type: PhotoType; label: string }> = [
  { key: 'rail', type: 'rail', label: 'Rail damage' },
  { key: 'deck', type: 'deck', label: 'Deck damage' },
  { key: 'super', type: 'super', label: 'Superstructure damage' },
  { key: 'sub', type: 'sub', label: 'Substructure damage' },
  { key: 'washout', type: 'washout', label: 'Washout photo' },
];

export default function PhotoSection(props: PhotoSectionProps): React.JSX.Element {
  const { photos, onCapture, onRemove, onDescribe, busy, destroyedMode, damageFlags } = props;

  const renderThumbs = (type: PhotoType) => {
    const matches = photos.filter((p) => p.photo_type === type);
    if (matches.length === 0) return null;
    return matches.map((p) => (
      <div key={p.id} className="photo-item">
        {p.dataUrl ? <img src={p.dataUrl} alt={p.description ?? ''} /> : null}
        <button type="button" className="rm" aria-label="Remove photo" onClick={() => onRemove(p.id)}>
          ×
        </button>
        <input
          className="photo-note"
          type="text"
          value={p.description ?? ''}
          placeholder="Add a note…"
          onChange={(e) => onDescribe(p.id, e.target.value)}
          aria-label="Photo note"
        />
      </div>
    ));
  };

  const renderAdd = (type: PhotoType, label: string) => (
    <button
      type="button"
      className="photo-add-compact"
      disabled={busy}
      onClick={() => {
        void onCapture(type);
      }}
      aria-label={label}
    >
      {busy ? 'Capturing…' : (<><Icon name="camera" size={16} /> Add photo</>)}
    </button>
  );

  const renderSlot = (slot: SlotConfig) => {
    const matches = photos.filter((p) => p.photo_type === slot.type);
    return (
      <div key={slot.type} className="field">
        <div>
          <span>{slot.label}</span>{' '}
          <span className={`req-badge ${slot.badgeClass}`}>{slot.badge}</span>
        </div>
        <div className="photo-grid">
          {renderThumbs(slot.type)}
          {matches.length === 0 ? renderAdd(slot.type, slot.label) : null}
        </div>
      </div>
    );
  };

  if (destroyedMode) {
    return (
      <div className="card">
        <h3>Destroyed bridge photos (required)</h3>
        {DESTROYED_SLOTS.map(renderSlot)}
      </div>
    );
  }

  const activeDamage = DAMAGE_MAP.filter((entry) => damageFlags[entry.key]);
  const conditionPhotos = photos.filter((p) => p.photo_type === 'condition');

  return (
    <div className="card">
      <h3>Standard photos</h3>
      {STANDARD_SLOTS.map(renderSlot)}

      <h3>Damage photos</h3>
      {activeDamage.length === 0 ? (
        <p className="muted">
          No damage recorded — damage photos appear here when a damage item is marked Yes.
        </p>
      ) : (
        activeDamage.map((entry) => {
          const matches = photos.filter((p) => p.photo_type === entry.type);
          return (
            <div key={entry.key} className="field">
              <div>
                <span>{entry.label}</span>
              </div>
              <div className="photo-grid">
                {renderThumbs(entry.type)}
                {matches.length === 0 ? renderAdd(entry.type, entry.label) : null}
              </div>
            </div>
          );
        })
      )}

      <h3>Condition photos</h3>
      {renderAdd('condition', 'Add condition photo')}
      <div className="photo-grid">
        {conditionPhotos.map((p) => (
          <div key={p.id} className="photo-item">
            {p.dataUrl ? <img src={p.dataUrl} alt={p.description ?? ''} /> : null}
            <button type="button" className="rm" aria-label="Remove photo" onClick={() => onRemove(p.id)}>
              ×
            </button>
            <input
              className="photo-note"
              type="text"
              value={p.description ?? ''}
              placeholder="Add a note…"
              onChange={(e) => onDescribe(p.id, e.target.value)}
              aria-label="Photo note"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
