import type { BorderCharacters } from '@opentui/core';

// Every glyph but the vertical is empty so `border={['left']}` draws a bare heavy bar and no frame.
export const BAR_CHARS: BorderCharacters = {
  topLeft: '', topRight: '', bottomLeft: '', bottomRight: '', horizontal: ' ',
  vertical: '┃', topT: '', bottomT: '', leftT: '', rightT: '', cross: '',
};
