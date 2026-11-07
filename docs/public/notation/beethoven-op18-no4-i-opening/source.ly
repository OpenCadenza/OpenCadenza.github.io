\version "2.26.0"
\language "english"

\score {
  \new StaffGroup <<
    \new Staff = "v1" {
      \set Staff.midiInstrument = "violin"
      % GM 40
      \clef treble \key c \minor \time 4/4 \tempo 4 = 138 \partial 4
  % m.0
  g4 \p
  % m.1
  c'2 ~ c'8 [ \grace { d'16 [ ( c' b ] ) } c'8 ( ef' d' ) ] |
  % m.2
  d'2 \sf ( c'4 \staccato ) c'4 |
  % m.3
  f'2 ~ f'8 [ \grace { g'16 [ ( f' e' ] ) } f'8 ( af' g' ) ] |
  % m.4
  g'2 \sf ( f'4 \staccato ) f'4 \bar "|."
    }
    \new Staff = "v2" {
      \set Staff.midiInstrument = "violin"
      % GM 40
      \clef treble \key c \minor \time 4/4 \partial 4
  % m.0
  r4
  % m.1
  g2. \p ( b4 ) |
  % m.2
  b2 \sf ( g4 \staccato ) r |
  % m.3
  c'2. ( e'4 ) |
  % m.4
  e'2 \sf ( c'4 \staccato ) r \bar "|."
    }
    \new Staff = "va" {
      \set Staff.midiInstrument = "viola"
      % GM 41
      \clef alto \key c \minor \time 4/4 \partial 4
  % m.0
  r4
  % m.1
  ef2. \p ( f4 ) |
  % m.2
  af4. \sf ( f8 ) ef4 \staccato r |
  % m.3
  af2. ( bf4 ) |
  % m.4
  df'4. \sf ( bf8 ) af4 \staccato r4 \bar "|."
    }
    \new Staff = "vc" {
      \set Staff.midiInstrument = "cello"
      % GM 42
      \clef bass \key c \minor \time 4/4 \partial 4
  % m.0
  r4
  % m.1
  c,8 \p c c c c c c c |
  % m.2
  c8 \sf c c c c c c c |
  % m.3
  c,8 c c c c c c c |
  % m.4
  c8 \sf c c c c c c c \bar "|."
    }
  >>
  \layout { }
  \midi { }
}
