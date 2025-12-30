import React from 'react';
import SectionCard from '../components/SectionCard';

export default function ProvidersView(): JSX.Element {
  return (
    <SectionCard
      title="Providers"
      description="Music services, radio, and custom sources. Wiring will follow in the next iteration."
    >
      <div className="placeholder">
        <p>Providers view placeholder.</p>
      </div>
    </SectionCard>
  );
}
