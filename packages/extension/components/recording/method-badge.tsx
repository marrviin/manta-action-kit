import { Tag } from 'antd';

const METHOD_COLORS: Record<string, string> = {
  GET: 'green',
  POST: 'blue',
  PUT: 'orange',
  PATCH: 'purple',
  DELETE: 'red',
};

export function MethodBadge({ method }: { method: string }) {
  const color = METHOD_COLORS[method.toUpperCase()] ?? 'default';
  return (
    <Tag color={color} className="me-0 font-semibold text-xs rounded">
      {method.toUpperCase()}
    </Tag>
  );
}

export function StatusBadge({ status }: { status: number }) {
  const color = status === 0 ? 'default' : status < 300 ? 'green' : status < 400 ? 'orange' : 'red';
  return (
    <Tag color={color} className="me-0 font-semibold text-xs rounded">
      {status === 0 ? 'ERR' : status}
    </Tag>
  );
}
