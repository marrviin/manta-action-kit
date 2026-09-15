import { useMemo } from 'react';
import { Collapse, Empty, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { aggregateEndpoints, attachDependencies } from '@/lib/recording/aggregate';
import type {
  ApiCall,
  EndpointSummary,
  FieldDependency,
  SchemaNode,
} from '@/lib/recording/types';

const { Text } = Typography;

/**
 * The "interface" view of a recording: its raw calls collapsed by method +
 * normalized URL path into distinct endpoint contracts (see aggregate.ts), each
 * with an inferred, redacted request/response schema. Purely derived from the
 * calls the parent already loaded — no extra I/O — so it stays in sync with the
 * recorded view without a separate fetch.
 */
export function EndpointsPanel({
  calls,
  deps,
}: {
  calls: ApiCall[];
  deps?: FieldDependency[];
}) {
  const endpoints = useMemo(
    () => attachDependencies(aggregateEndpoints(calls), calls, deps ?? []),
    [calls, deps],
  );

  if (endpoints.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={false} />
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-auto py-4 px-3">
      <Collapse
        accordion
        items={endpoints.map((ep) => ({
          key: ep.key,
          label: <EndpointHeader ep={ep} />,
          children: <EndpointBody ep={ep} />,
        }))}
      />
    </div>
  );
}

/** The color for an HTTP method tag — GET/read vs. mutating verbs. */
function methodColor(method: string): string {
  switch (method) {
    case 'GET':
      return 'blue';
    case 'POST':
      return 'green';
    case 'PUT':
    case 'PATCH':
      return 'orange';
    case 'DELETE':
      return 'red';
    default:
      return 'default';
  }
}

/** One endpoint's collapse header: method tag + normalized path + call count. */
function EndpointHeader({ ep }: { ep: EndpointSummary }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <Tag color={methodColor(ep.method)} className="m-0! shrink-0">
        {ep.method}
      </Tag>
      <Text className="min-w-0 flex-1 truncate font-mono text-[13px]!">{ep.pathKey}</Text>
      <Tag className="m-0! shrink-0">×{ep.callCount}</Tag>
    </div>
  );
}

/** The expanded body: statuses, query keys, and request/response schema trees. */
function EndpointBody({ ep }: { ep: EndpointSummary }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-1">
        <Text type="secondary" className="text-[12px]!">
          {t('endpoints.statuses')}
        </Text>
        {ep.statuses.length > 0 ? (
          ep.statuses.map((s) => (
            <Tag key={s} color={s >= 400 ? 'red' : 'default'} className="m-0!">
              {s}
            </Tag>
          ))
        ) : (
          <Text type="secondary">—</Text>
        )}
      </div>

      {ep.queryKeys.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <Text type="secondary" className="text-[12px]!">
            {t('endpoints.query')}
          </Text>
          {ep.queryKeys.map((k) => (
            <Tag key={k} className="m-0! font-mono">
              {k}
            </Tag>
          ))}
        </div>
      )}

      {ep.inputsFrom && ep.inputsFrom.length > 0 && (
        <div>
          <Text strong className="block text-[12px]! mb-1">
            {t('endpoints.inputsFrom')}
          </Text>
          <div className="flex flex-col gap-1">
            {ep.inputsFrom.map((inp, i) => {
              const to = inp.toPath ? `${inp.toLocation}.${inp.toPath}` : inp.toLocation;
              return (
                <Text key={`${to}-${i}`} className="font-mono text-[12px]! leading-5">
                  {t('endpoints.inputFromLabel', {
                    to,
                    from: inp.fromEndpointKey,
                    fromPath: inp.fromPath || '(body)',
                  })}
                </Text>
              );
            })}
          </div>
        </div>
      )}

      <SchemaSection title={t('endpoints.request')} node={ep.requestSchema} />
      <SchemaSection title={t('endpoints.response')} node={ep.responseSchema} />
    </div>
  );
}

/** A labeled schema block; renders a placeholder when no schema was inferred. */
function SchemaSection({ title, node }: { title: string; node: SchemaNode | null }) {
  const { t } = useTranslation();
  return (
    <div>
      <Text strong className="block text-[12px]! mb-1">
        {title}
      </Text>
      {node ? (
        <div className="font-mono text-[12px] leading-5">
          <SchemaTree node={node} name={null} depth={0} />
        </div>
      ) : (
        <Text type="secondary" className="text-[12px]!">
          {t('endpoints.noSchema')}
        </Text>
      )}
    </div>
  );
}

/**
 * Recursively render a SchemaNode as an indented tree: each line shows the field
 * name, its kind, optional/nullable flags, and (for scalars) a redacted example.
 * Objects/arrays recurse one level deeper.
 */
function SchemaTree({
  node,
  name,
  depth,
}: {
  node: SchemaNode;
  name: string | null;
  depth: number;
}) {
  const { t } = useTranslation();
  const flags: string[] = [];
  if (node.optional) flags.push(t('endpoints.optional'));
  if (node.nullable) flags.push(t('endpoints.nullable'));

  return (
    <div style={{ paddingLeft: depth > 0 ? 14 : 0 }}>
      <div className="flex flex-wrap items-baseline gap-1">
        {name != null && <span className="text-[#1677ff]">{name}</span>}
        <Tag className="m-0! text-[11px]!" color="geekblue">
          {node.kind}
        </Tag>
        {flags.map((f) => (
          <Tag key={f} className="m-0! text-[11px]!">
            {f}
          </Tag>
        ))}
        {node.example != null && node.kind !== 'object' && node.kind !== 'array' && (
          <Text type="secondary" className="text-[11px]!">
            {node.example}
          </Text>
        )}
      </div>

      {node.kind === 'object' &&
        node.properties &&
        Object.entries(node.properties).map(([key, child]) => (
          <SchemaTree key={key} node={child} name={key} depth={depth + 1} />
        ))}

      {node.kind === 'array' && node.items && (
        <SchemaTree node={node.items} name={t('endpoints.items')} depth={depth + 1} />
      )}
    </div>
  );
}
