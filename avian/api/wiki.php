<?php
// AvianVisitors - Wikipedia lead proxy.
//
// The detail modal calls /avian/api/wiki.php?sci=<name> for the species
// description. We request Wikipedia's complete plain-text lead (every
// paragraph before the first section) plus its thumbnail. The shorter REST
// summary can collapse some species to a single sentence even when the lead
// contains useful field-guide detail. Alongside the untouched lead we return
// a field-guide excerpt made only from complete source sentences: a short
// orientation, a more detailed paragraph, and (when the article actually
// supplies one) a separate field-mark note. A terse lead gets a bounded body
// extract; a substantial lead with no appearance prose gets only its named
// Description / Identification / Appearance section. Nothing is clipped or
// rewritten, so the UI can never end a thought with a synthetic ellipsis.
// Cached at the browser + Caddy edge for 24 h because species descriptions
// don't materially change during a visit.
//
// Pinned to wikimedia.org / wikipedia.org for the photo URL to block
// SSRF if Wikipedia ever returns a poisoned redirect target.

declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: public, max-age=86400');

function textLength(string $value): int
{
    return function_exists('mb_strlen') ? mb_strlen($value, 'UTF-8') : strlen($value);
}

// At the postcard's common compact width, the 12.5px body copy wraps at
// roughly 50 characters per line; the smaller field-mark note holds a few
// more. These are deterministic fit proxies, not clipping lengths: selection
// below always removes a complete source sentence or leaves the prose intact.
const FIELD_GUIDE_BODY_LINE_MEASURE = 50;
const FIELD_GUIDE_MARK_LINE_MEASURE = 54;
const FIELD_GUIDE_MAX_ESTIMATED_LINES = 17;
const FIELD_GUIDE_MAX_MAIN_CHARS = 575;

function cleanWikiLead(string $value): string
{
    // TextExtracts occasionally leaves an empty pronunciation pair behind
    // (the Mallard lead is one example). Preserve real parentheticals and
    // paragraph boundaries while making spacing deterministic.
    $value = preg_replace('/\(\s*\)/u', '', $value) ?? $value;
    $value = preg_replace('/[\t\x{00A0} ]+/u', ' ', $value) ?? $value;
    $value = preg_replace('/ *\R+ */u', "\n", $value) ?? $value;
    return trim($value);
}

/** @return list<string> */
function wikiLeadSentences(string $value): array
{
    $flat = preg_replace('/\R+/u', ' ', trim($value)) ?? trim($value);
    if ($flat === '') {
        return [];
    }

    // A boundary must be followed by a plausible sentence opener. This avoids
    // breaking common lead prose at abbreviations such as "U.S. as" or
    // "spp. coronata" without pretending to be a linguistic sentence parser.
    $parts = preg_split(
        '/(?:(?<=[.!?])|(?<=[.!?]["”’\')\]]))\s+(?=["“‘\'(]?[A-Z0-9])/u',
        $flat,
        -1,
        PREG_SPLIT_NO_EMPTY
    );
    if (!is_array($parts)) {
        return [$flat];
    }
    return array_values(array_filter(array_map('trim', $parts), static function (string $part): bool {
        return $part !== '';
    }));
}

function isCompleteWikiSentence(string $value): bool
{
    // TextExtracts appends three dots when `exchars` stops inside a sentence.
    // That final fragment is transport truncation, not article prose.
    if (preg_match('/(?:\.{3}|…)\s*["”’\')\]]*$/u', $value)) {
        return false;
    }
    return (bool)preg_match('/[.!?]\s*["”’\')\]]*$/u', $value);
}

function wikiSupplement(string $expanded, string $lead): string
{
    $expanded = cleanWikiLead($expanded);
    $lead = cleanWikiLead($lead);
    if ($expanded === '' || $lead === '' || strpos($expanded, $lead) !== 0) {
        return '';
    }

    $remainder = trim(substr($expanded, strlen($lead)));
    if ($remainder === '') {
        return '';
    }

    // Plain TextExtracts puts section titles on their own lines. Remove those
    // short, unpunctuated labels while retaining prose paragraph order.
    $lines = preg_split('/\R+/u', $remainder, -1, PREG_SPLIT_NO_EMPTY);
    $body = [];
    foreach (is_array($lines) ? $lines : [] as $line) {
        $line = trim($line);
        if ($line === '') {
            continue;
        }
        if (textLength($line) <= 80 && !preg_match('/[.!?]["”’\')\]]*$/u', $line)) {
            continue;
        }
        $body[] = $line;
    }

    $sentences = array_values(array_filter(
        wikiLeadSentences(implode(' ', $body)),
        'isCompleteWikiSentence'
    ));
    return implode(' ', $sentences);
}

/**
 * Fetch the article's own Description / Identification / Appearance section.
 *
 * Most leads already include field marks. This fallback is intentionally
 * narrow so articles such as House Finch can still supply sourced appearance
 * prose without downloading or heuristically scraping an entire article.
 */
function wikiDescriptionSection(string $title, $ctx): string
{
    $sectionsUrl = 'https://en.wikipedia.org/w/api.php?' . http_build_query([
        'action'        => 'parse',
        'format'        => 'json',
        'formatversion' => '2',
        'redirects'     => '1',
        'prop'          => 'sections',
        'page'          => $title,
    ], '', '&', PHP_QUERY_RFC3986);
    $sectionsRaw = @file_get_contents($sectionsUrl, false, $ctx);
    $sectionsJson = $sectionsRaw !== false ? json_decode($sectionsRaw, true) : null;
    $sections = is_array($sectionsJson) ? ($sectionsJson['parse']['sections'] ?? null) : null;
    if (!is_array($sections)) {
        return '';
    }

    $wanted = ['description', 'identification', 'appearance'];
    $sectionIndex = null;
    foreach ($wanted as $heading) {
        foreach ($sections as $section) {
            $line = is_array($section) ? (string)($section['line'] ?? '') : '';
            $line = html_entity_decode(strip_tags($line), ENT_QUOTES | ENT_HTML5, 'UTF-8');
            $line = strtolower(trim($line));
            if ($line === $heading) {
                $sectionIndex = (string)($section['index'] ?? '');
                break 2;
            }
        }
    }
    if ($sectionIndex === null || $sectionIndex === '') {
        return '';
    }

    $sectionUrl = 'https://en.wikipedia.org/w/api.php?' . http_build_query([
        'action'             => 'parse',
        'format'             => 'json',
        'formatversion'      => '2',
        'redirects'          => '1',
        'prop'               => 'text',
        'page'               => $title,
        'section'            => $sectionIndex,
        'disableeditsection' => '1',
        'disabletoc'         => '1',
    ], '', '&', PHP_QUERY_RFC3986);
    $sectionRaw = @file_get_contents($sectionUrl, false, $ctx);
    $sectionJson = $sectionRaw !== false ? json_decode($sectionRaw, true) : null;
    $html = is_array($sectionJson) ? ($sectionJson['parse']['text'] ?? '') : '';
    if (is_array($html)) {
        $html = (string)($html['*'] ?? '');
    }
    if (!is_string($html) || $html === '' || !class_exists('DOMDocument')) {
        return '';
    }

    $previousErrors = libxml_use_internal_errors(true);
    $document = new DOMDocument();
    $loaded = $document->loadHTML(
        '<meta charset="utf-8"><main id="wiki-section">' . $html . '</main>',
        LIBXML_NONET | LIBXML_NOERROR | LIBXML_NOWARNING
    );
    libxml_clear_errors();
    libxml_use_internal_errors($previousErrors);
    if (!$loaded) {
        return '';
    }

    $xpath = new DOMXPath($document);
    foreach (['//sup', '//style', '//script', '//table', '//figure'] as $query) {
        $nodes = $xpath->query($query);
        foreach ($nodes ?: [] as $node) {
            $node->parentNode?->removeChild($node);
        }
    }

    $paragraphs = [];
    $nodes = $xpath->query('//*[@id="wiki-section"]//p');
    foreach ($nodes ?: [] as $node) {
        $text = html_entity_decode((string)$node->textContent, ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $text = preg_replace('/\[\s*\d+(?:\s*[-,]\s*\d+)*\s*\]/u', '', $text) ?? $text;
        $text = cleanWikiLead($text);
        if ($text !== '') {
            $paragraphs[] = $text;
        }
    }
    return implode("\n", $paragraphs);
}

/**
 * Build a compact field-guide reading of the lead without rewriting it.
 *
 * The first paragraph is one or two complete sentences and answers “what is
 * this bird?” The second advances through the lead until it has enough useful
 * range, appearance, habitat, or behavior context. The ceilings are soft: a
 * long source sentence is kept whole rather than cut off.
 *
 * @return list<string>
 */
function fieldGuideParagraphs(string $lead, array $excluded = []): array
{
    $lead = cleanWikiLead($lead);
    $sentences = wikiLeadSentences($lead);
    if ($excluded) {
        $excludedLookup = array_fill_keys($excluded, true);
        $sentences = array_values(array_filter(
            $sentences,
            static function (string $sentence) use ($excludedLookup): bool {
                return !isset($excludedLookup[$sentence]);
            }
        ));
    }
    $count = count($sentences);
    if ($count <= 1) {
        return $sentences;
    }

    $sourceParagraphs = preg_split('/\R+/u', $lead, -1, PREG_SPLIT_NO_EMPTY);
    $firstSourceIsIntro = is_array($sourceParagraphs)
        && count($sourceParagraphs) > 1
        && count(wikiLeadSentences((string)$sourceParagraphs[0])) === 1;

    $intro = [$sentences[0]];
    $cursor = 1;
    $introLength = textLength($sentences[0]);
    if (!$firstSourceIsIntro && $count > 2 && $introLength < 150) {
        $withSecond = $introLength + 1 + textLength($sentences[1]);
        if ($withSecond <= 285) {
            $intro[] = $sentences[1];
            $introLength = $withSecond;
            $cursor = 2;
        }
    }

    $detail = [];
    $detailLength = 0;
    $skippedMinorVagrancy = false;
    for (; $cursor < $count; $cursor += 1) {
        $sentence = $sentences[$cursor];

        // A short aside about exceptional vagrancy is lower-value card copy
        // when two fuller context sentences follow. Great Blue Heron's lead is
        // the representative case: retain its white-morph context and omit the
        // one-off Europe aside. This is selection only; source text is never
        // rewritten or clipped.
        $minorVagrancy = textLength($sentence) <= 140 && (bool)preg_match(
            '/(?:\b(?:rare|occasional(?:ly)?)\b[^.!?]{0,90}\bvagrant\b|\bvagrant\b[^.!?]{0,90}\b(?:rare|occasional(?:ly)?)\b)/iu',
            $sentence
        );
        if ($minorVagrancy && ($count - $cursor - 1) >= 2) {
            $skippedMinorVagrancy = true;
            continue;
        }

        // Once that low-priority aside has been bypassed, the next two source
        // sentences form the complete context block. Do not drift into a
        // Description-section supplement merely because it was fetched for
        // the separate field-mark note.
        if ($skippedMinorVagrancy && count($detail) >= 2) {
            break;
        }

        $nextDetailLength = $detailLength + ($detail ? 1 : 0) + textLength($sentence);
        $nextTotalLength = $introLength + 2 + $nextDetailLength;

        // Two complete context sentences are normally enough. Keep them even
        // when one is long, but do not let a third sentence push the middle
        // paragraph past a calm field-guide measure (Anna's Hummingbird is the
        // representative case). The sentence is omitted whole, never clipped.
        if (count($detail) >= 2 && $nextDetailLength > 380) {
            break;
        }

        // Once the excerpt is already useful, do not pull in a whole long
        // sentence merely to hit a target. This is a soft ceiling, never a cut.
        if ($detail && count($detail) >= 2 && $nextTotalLength > 700
            && ($introLength + 2 + $detailLength) >= 430) {
            break;
        }

        $detail[] = $sentence;
        $detailLength = $nextDetailLength;
        if (count($detail) >= 2 && $detailLength >= 360
            && ($introLength + 2 + $detailLength) >= 430) {
            break;
        }
    }

    // With two or more source sentences, keep a true second paragraph even
    // when the lead is unusually terse (Song Sparrow is a useful example).
    if (!$detail && $cursor < $count) {
        $detail[] = $sentences[$cursor];
    }

    return [implode(' ', $intro), implode(' ', $detail)];
}

/**
 * Keep the three-part About composition inside the compact-card envelope.
 *
 * The first sentence of both prose paragraphs and the first field-mark
 * sentence are structural, so they are never removed. If the sourced copy is
 * still too tall, an extra orientation sentence goes first; then an extra
 * context or field-mark sentence is removed according to which budget is
 * actually over. Every operation is sentence-level and preserves source text.
 *
 * @param list<string> $paragraphs
 * @param list<string> $distinctive
 * @return array{paragraphs: list<string>, distinctive: list<string>}
 */
function fitFieldGuideCard(array $paragraphs, array $distinctive): array
{
    $groups = [];
    foreach (array_slice($paragraphs, 0, 2) as $paragraph) {
        $groups[] = array_values(array_filter(
            wikiLeadSentences($paragraph),
            'isCompleteWikiSentence'
        ));
    }
    while (count($groups) < 2) {
        $groups[] = [];
    }
    $marks = array_values(array_filter($distinctive, 'isCompleteWikiSentence'));

    $paragraphValues = static function () use (&$groups): array {
        return array_map(
            static fn(array $sentences): string => implode(' ', $sentences),
            $groups
        );
    };
    $mainLength = static function () use ($paragraphValues): int {
        return textLength(implode(' ', array_filter($paragraphValues())));
    };
    $estimatedLines = static function () use ($paragraphValues, &$marks): int {
        $lines = 0;
        foreach ($paragraphValues() as $paragraph) {
            if ($paragraph !== '') {
                $lines += (int)ceil(textLength($paragraph) / FIELD_GUIDE_BODY_LINE_MEASURE);
            }
        }
        $fieldMarks = implode(' ', $marks);
        if ($fieldMarks !== '') {
            $lines += (int)ceil(textLength($fieldMarks) / FIELD_GUIDE_MARK_LINE_MEASURE);
        }
        return $lines;
    };

    while ($mainLength() > FIELD_GUIDE_MAX_MAIN_CHARS
        || $estimatedLines() > FIELD_GUIDE_MAX_ESTIMATED_LINES) {
        // An intro needs only one high-level orientation sentence. This is the
        // least disruptive first trim when names or taxonomy make it verbose.
        if (count($groups[0]) > 1) {
            array_pop($groups[0]);
            continue;
        }
        // When the two main paragraphs themselves are over measure, preserve
        // the first context sentence and omit only a complete trailing one.
        if ($mainLength() > FIELD_GUIDE_MAX_MAIN_CHARS && count($groups[1]) > 1) {
            array_pop($groups[1]);
            continue;
        }
        // A long comparison note may remain useful as one strong field mark.
        if (count($marks) > 1) {
            array_pop($marks);
            continue;
        }
        if (count($groups[1]) > 1) {
            array_pop($groups[1]);
            continue;
        }
        break;
    }

    return [
        'paragraphs' => array_values(array_filter($paragraphValues())),
        'distinctive' => $marks,
    ];
}

/**
 * Return one or two verbatim sentences that describe visible field marks.
 *
 * This is deliberately conservative. A colour word alone is not enough: the
 * sentence must also name anatomy/plumage or explicitly describe how the bird
 * is recognised. If the article offers no such sentence, the card simply
 * omits the note rather than inventing field-guide copy.
 *
 * @return list<string>
 */
function distinctiveFieldMarks(string $source): array
{
    $sentences = array_values(array_filter(
        wikiLeadSentences(cleanWikiLead($source)),
        'isCompleteWikiSentence'
    ));
    $candidates = [];

    foreach ($sentences as $index => $sentence) {
        $anatomyMatches = preg_match_all(
            '/\b(?:plumage|underparts?|upperparts?|breasts?|bell(?:y|ies)|throats?|crowns?|caps?|foreheads?|napes?|heads?|necks?|shoulders?|faces?|cheeks?|masks?|eyes?|eye[ -]?rings?|bills?|beaks?|tails?|wings?|wingbars?|feathers?|crests?|backs?|flanks?|legs?|feet|patch(?:es)?|markings?)\b/iu',
            $sentence
        );
        $appearanceMatches = preg_match_all(
            '/\b(?:black|white|gr[ae]y|brown|reddish|red|orange|yellow|golden|olive|blue|green|buff|rufous|pink|purple|pale|dark|bright|glossy|iridescent|streaked|striped|barred|spotted|mottled|long|short|slender|stocky)\b/iu',
            $sentence
        );
        $recognitionMatches = preg_match_all(
            '/\b(?:distinguish(?:ed|able)?|identif(?:ied|iable)|recogniz(?:ed|able)|characteri[sz]ed|distinctive|prominent|noticeable|field mark)\b/iu',
            $sentence
        );

        // Require visible evidence, not a loose colour mention in a place,
        // subspecies name, food item, or historical anecdote.
        if (!$anatomyMatches || (!$appearanceMatches && !$recognitionMatches)) {
            continue;
        }

        $score = min(4, (int)$anatomyMatches) * 3
            + min(4, (int)$appearanceMatches)
            + min(2, (int)$recognitionMatches) * 3;
        if (preg_match('/\b(?:males?|females?|adults?|juveniles?|immatures?|in flight)\b/iu', $sentence)) {
            $score += 2;
        }
        if (textLength($sentence) <= 330) {
            $score += 1;
        }
        $candidates[] = ['index' => $index, 'score' => $score, 'sentence' => $sentence];
    }

    if (!$candidates) {
        return [];
    }

    usort($candidates, static function (array $a, array $b): int {
        return $b['score'] <=> $a['score'] ?: $a['index'] <=> $b['index'];
    });

    $chosen = [$candidates[0]];
    if (count($sentences) <= 3) {
        return [$candidates[0]['sentence']];
    }
    $remaining = array_slice($candidates, 1);
    // Prefer a sex/age/flight comparison over an adjacent but less useful
    // inventory sentence (for example the red male versus streaked female
    // House Finch). Fall back to adjacent source prose when there is no such
    // comparison.
    foreach ([true, false] as $comparisonPass) {
        foreach ($remaining as $candidate) {
            if ($candidate['score'] < 6) {
                continue;
            }
            $combinedLength = textLength($chosen[0]['sentence']) + 1 + textLength($candidate['sentence']);
            if ($combinedLength > 440) {
                continue;
            }
            $addsComparison = (bool)preg_match(
                '/\b(?:males?|females?|adults?|juveniles?|immatures?|both sexes|in flight)\b/iu',
                $candidate['sentence']
            );
            if ($comparisonPass !== $addsComparison) {
                continue;
            }
            if (!$addsComparison && abs($candidate['index'] - $chosen[0]['index']) > 1) {
                continue;
            }
            $chosen[] = $candidate;
            break 2;
        }
    }

    usort($chosen, static function (array $a, array $b): int {
        return $a['index'] <=> $b['index'];
    });
    return array_column($chosen, 'sentence');
}

$sci = trim((string)($_GET['sci'] ?? ''));
if ($sci === '') {
    http_response_code(400);
    echo json_encode(['error' => 'sci required']);
    exit;
}
if (!preg_match('/^[A-Za-z]{2,40}(?:[ ][a-z]{2,40}){1,3}$/', $sci)) {
    http_response_code(400);
    echo json_encode(['error' => 'invalid sci']);
    exit;
}

$ua = getenv('AV_USER_AGENT') ?: 'AvianVisitors/1.0 (+https://github.com/Twarner491/AvianVisitors)';
$ctx = stream_context_create([
    'http' => ['header' => "User-Agent: $ua\r\n", 'timeout' => 8],
]);
$url = 'https://en.wikipedia.org/w/api.php?' . http_build_query([
    'action'        => 'query',
    'format'        => 'json',
    'formatversion' => '2',
    'redirects'     => '1',
    'prop'          => 'extracts|pageimages',
    'exintro'       => '1',
    'explaintext'   => '1',
    'piprop'        => 'thumbnail',
    'pithumbsize'   => '640',
    'titles'        => $sci,
], '', '&', PHP_QUERY_RFC3986);
$raw = @file_get_contents($url, false, $ctx);
if ($raw === false) {
    echo json_encode(['extract' => null, 'thumbnail' => null]);
    exit;
}
$j = json_decode($raw, true);
if (!is_array($j)) {
    echo json_encode(['extract' => null, 'thumbnail' => null]);
    exit;
}

$page = $j['query']['pages'][0] ?? null;
if (!is_array($page)) {
    echo json_encode(['extract' => null, 'thumbnail' => null]);
    exit;
}

$thumb = $page['thumbnail']['source'] ?? null;
if ($thumb) {
    $host = parse_url((string)$thumb, PHP_URL_HOST) ?: '';
    if (!preg_match('/(?:^|\.)(?:wikimedia\.org|wikipedia\.org)$/i', $host)) {
        $thumb = null;
    }
}

$extract = isset($page['extract']) && is_string($page['extract'])
    ? cleanWikiLead($page['extract'])
    : null;
$pageTitle = isset($page['title']) && is_string($page['title']) ? $page['title'] : null;
$aboutSource = $extract ?? '';
$initialParagraphs = $aboutSource ? fieldGuideParagraphs($aboutSource) : [];
$initialLength = textLength(implode(' ', $initialParagraphs));

// A handful of otherwise common species have only a sentence or two in the
// lead. Pull the beginning of the article in those cases so the second About
// paragraph can carry actual field marks or behavior rather than filler.
if ($pageTitle && $extract && $initialLength < 360) {
    $expandedUrl = 'https://en.wikipedia.org/w/api.php?' . http_build_query([
        'action'          => 'query',
        'format'          => 'json',
        'formatversion'   => '2',
        'redirects'       => '1',
        'prop'            => 'extracts',
        'explaintext'     => '1',
        'exsectionformat' => 'plain',
        'exchars'         => '1200',
        'titles'          => $pageTitle,
    ], '', '&', PHP_QUERY_RFC3986);
    $expandedRaw = @file_get_contents($expandedUrl, false, $ctx);
    $expandedJson = $expandedRaw !== false ? json_decode($expandedRaw, true) : null;
    $expandedPage = is_array($expandedJson) ? ($expandedJson['query']['pages'][0] ?? null) : null;
    $expandedExtract = is_array($expandedPage) && isset($expandedPage['extract'])
        && is_string($expandedPage['extract'])
        ? $expandedPage['extract']
        : '';
    $supplement = wikiSupplement($expandedExtract, $extract);
    if ($supplement !== '') {
        $aboutSource .= "\n" . $supplement;
    }
}

// Some substantial leads cover range and taxonomy but omit appearance (House
// Finch is one). Only then, read the article's named field-description section.
$initialDistinctive = $aboutSource ? distinctiveFieldMarks($aboutSource) : [];
if (!$initialDistinctive && $pageTitle) {
    $descriptionSection = wikiDescriptionSection($pageTitle, $ctx);
    if ($descriptionSection !== '') {
        $aboutSource .= "\n" . $descriptionSection;
    }
}

$distinctiveSentences = $aboutSource ? distinctiveFieldMarks($aboutSource) : [];
$paragraphs = $aboutSource ? fieldGuideParagraphs($aboutSource, $distinctiveSentences) : [];

// Keep the intro + context structure intact. On an exceptionally sparse
// article, omitting a field-mark note is better than repeating the same source
// sentence in two places or collapsing About to a single paragraph.
if (count(array_filter($paragraphs)) < 2) {
    $distinctiveSentences = [];
    $paragraphs = $aboutSource ? fieldGuideParagraphs($aboutSource) : [];
}
$fitted = fitFieldGuideCard($paragraphs, $distinctiveSentences);
$paragraphs = $fitted['paragraphs'];
$distinctiveSentences = $fitted['distinctive'];
$distinctive = $distinctiveSentences ? implode(' ', $distinctiveSentences) : null;
$sourceUrl = $pageTitle
    ? 'https://en.wikipedia.org/wiki/' . str_replace('%2F', '/', rawurlencode(str_replace(' ', '_', $pageTitle)))
    : null;

echo json_encode([
    // `extract` remains the complete lead for compatibility; current clients
    // use the structured, complete-sentence `paragraphs` value below.
    'extract'   => $extract,
    'paragraphs' => $paragraphs,
    'distinctive' => $distinctive,
    'thumbnail' => $thumb ? ['source' => $thumb] : null,
    'title'     => $pageTitle,
    'source'    => $sourceUrl ? [
        'name' => 'Wikipedia',
        'url' => $sourceUrl,
        'license' => 'CC BY-SA 4.0',
    ] : null,
]);
