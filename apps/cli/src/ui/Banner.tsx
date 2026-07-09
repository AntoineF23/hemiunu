import { Box, Text } from "ink";
import { PAPYRUS, SAND } from "./theme";

const LOGO = String.raw`
                                          _L/L
                                        _LT/l_L_
                                      _LLl/L_T_lL_
                  _T/L              _LT|L/_|__L_|_L_
                _Ll/l_L_          _TL|_T/_L_|__T__|_l_
              _TLl/T_l|_L_      _LL|_Tl/_|__l___L__L_|L_
            _LT_L/L_|_L_l_L_  _'|_|_|T/_L_l__T _ l__|__|L_
          _Tl_L|/_|__|_|__T _LlT_|_Ll/_l_ _|__[ ]__|__|_l_L_
   jjs_ _LT_l_l/|__|__l_T _T_L|_|_|l/___|__ | _l__|_ |__|_T_L_  __

                          nn_r   nn_r                 __
                    __   /l(\   /l)\      nn_r
              __                         /\(\    __`;

// The pyramid logo + the name, with an Egyptian-tinted subtitle.
export function Banner() {
  return (
    <Box flexDirection="column">
      <Text color={SAND}>{LOGO}</Text>
      <Text>
        <Text color={SAND} bold>
          {"   HEMIUNU"}
        </Text>
        <Text color={PAPYRUS}>{"  ☥  product agent"}</Text>
      </Text>
    </Box>
  );
}
