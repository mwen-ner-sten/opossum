export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand" aria-label="OPOSSUM">
      <svg className="brand-mark" viewBox="0 0 44 44" role="img" aria-label="Possum face">
        <path d="M9 16 4 9l10 3M35 16l5-7-10 3" />
        <path d="M8 19c2-8 8-12 14-12s12 4 14 12c2 8-4 17-14 18C12 36 6 27 8 19Z" />
        <circle cx="16" cy="21" r="2" />
        <circle cx="28" cy="21" r="2" />
        <path d="m18 28 4 3 4-3-4-2-4 2Z" />
        <path d="M22 31v3" />
      </svg>
      {!compact && (
        <div>
          <strong>OPOSSUM</strong>
          <span>Endpoint operations</span>
        </div>
      )}
    </div>
  );
}
