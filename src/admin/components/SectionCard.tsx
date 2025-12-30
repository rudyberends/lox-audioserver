import React from 'react';
import './SectionCard.css';

interface SectionCardProps {
  title: string;
  children?: React.ReactNode;
  description?: string;
}

export default function SectionCard({
  title,
  description,
  children,
}: SectionCardProps): JSX.Element {
  return (
    <section className="section-card">
      <header className="section-card__header">
        <div>
          <h2>{title}</h2>
          {description ? <p className="section-card__description">{description}</p> : null}
        </div>
      </header>
      <div className="section-card__body">{children}</div>
    </section>
  );
}
