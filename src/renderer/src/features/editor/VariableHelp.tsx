import type { PlaceholderUsage } from '@core/templates';

/** Highlights `{{...}}` tokens inside a field value so the placeholder is easy to spot. */
function Highlighted({ value }: { value: string }) {
  const parts = value.split(/(\{\{[^}]*\}\})/g);
  return (
    <code>
      {parts.map((part, index) =>
        part.startsWith('{{') ? <mark key={index}>{part}</mark> : <span key={index}>{part}</span>,
      )}
    </code>
  );
}

/**
 * Explains what each template variable is for by showing every check field that reads it.
 * `names` limits the list to specific variables (without the `vars.` prefix).
 */
export function VariableHelp({
  usages,
  names,
  intro,
}: {
  usages: PlaceholderUsage[];
  names?: string[];
  intro?: string;
}) {
  const wanted = names ? new Set(names.map((name) => `vars.${name}`)) : undefined;
  const variables = [...new Set(usages.map((usage) => usage.name))].filter(
    (name) => name.startsWith('vars.') && (!wanted || wanted.has(name)),
  );
  if (variables.length === 0) return null;
  return (
    <div className="variable-help">
      <p>
        {intro ??
          'Variables are values that differ per site, such as a port or a virtual host name. A template reads them as {{vars.name}}; each target supplies its own value under Variables, or an import maps them from a column.'}
      </p>
      <dl>
        {variables.map((name) => (
          <div key={name}>
            <dt>
              <code>{`{{${name}}}`}</code>
            </dt>
            <dd>
              {usages
                .filter((usage) => usage.name === name)
                .map((usage) => (
                  <span key={`${usage.checkId}.${usage.field}`}>
                    <strong>{usage.checkName}</strong> · {usage.field}:{' '}
                    <Highlighted value={usage.value} />
                  </span>
                ))}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
