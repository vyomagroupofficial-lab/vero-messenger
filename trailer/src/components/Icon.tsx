import React from 'react';
import {ICONS} from './icons.generated';

export const Icon: React.FC<{
  name: string;
  size: number;
  color: string;
  style?: React.CSSProperties;
}> = ({name, size, color, style}) => {
  const body = ICONS[name];
  if (!body) throw new Error(`Unknown icon "${name}" — add it to icons.generated.ts`);
  return (
    <svg
      viewBox="0 0 512 512"
      width={size}
      height={size}
      fill={color}
      color={color}
      style={{display: 'block', flexShrink: 0, ...style}}
      dangerouslySetInnerHTML={{__html: body}}
    />
  );
};
