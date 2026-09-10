(function (global) {
  'use strict';

  const subHeroPageKeys = ['research', 'members', 'publications', 'gallery', 'contact'];
  const pageContentSchema = Object.freeze({
    home: {
      research: { smallLabel: 'string', title: 'string', subtitle: 'string', description: 'string', buttonText: 'string' },
      publicationsPreview: { smallLabel: 'string', title: 'string', buttonText: 'string' },
      galleryPreview: { smallLabel: 'string', title: 'string', buttonText: 'string' },
    },
    research: {
      banner: { smallLabel: 'string', title: 'string', description: 'string' },
      topicTabLabel: 'string',
      statement: { title: 'string' },
      topics: { smallLabel: 'string', title: 'string' },
    },
    members: { banner: { smallLabel: 'string', title: 'string', description: 'string' } },
    publications: { banner: { smallLabel: 'string', title: 'string', description: 'string' } },
    gallery: {
      banner: { smallLabel: 'string', title: 'string', description: 'string' },
      section: { smallLabel: 'string', title: 'string', description: 'string' },
    },
    contact: {
      banner: { smallLabel: 'string', title: 'string', description: 'string' },
      section: { smallLabel: 'string', title: 'string' },
    },
  });

  function isRecord(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  function validatePageContentNode(value, schema, label, errors) {
    if (!isRecord(value)) {
      errors.push(`${label}는 객체여야 합니다.`);
      return;
    }
    Object.keys(value).forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(schema, key)) {
        errors.push(`${label}.${key}는 지원하지 않는 항목입니다.`);
      }
    });
    Object.keys(schema).forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(value, key)) return;
      const expected = schema[key];
      if (expected === 'string') {
        if (typeof value[key] !== 'string') {
          errors.push(`${label}.${key}는 문자열이어야 합니다.`);
        } else {
          validateInlineMarkup(value[key], `${label}.${key}`, errors);
        }
        return;
      }
      validatePageContentNode(value[key], expected, `${label}.${key}`, errors);
    });
  }

  function validateOptionalPageContent(value, errors) {
    if (!Object.prototype.hasOwnProperty.call(value, 'pageContent')) return;
    validatePageContentNode(value.pageContent, pageContentSchema, 'pageContent', errors);
  }

  function isSafeExternalUrl(value) {
    if (value === '') return true;
    if (
      typeof value !== 'string'
      || value !== value.trim()
      || value.length > 2048
      || /[\u0000-\u001f\u007f]/.test(value)
    ) return false;
    try {
      const parsed = new URL(value);
      return ['http:', 'https:'].includes(parsed.protocol)
        && Boolean(parsed.hostname)
        && !parsed.username
        && !parsed.password;
    } catch {
      return false;
    }
  }

  function validateOptionalExternalUrl(item, label, errors) {
    if (!Object.prototype.hasOwnProperty.call(item, 'link_url')) return;
    if (item.link_url === null) return;
    if (typeof item.link_url !== 'string') {
      errors.push(`${label}.link_url은 문자열 또는 null이어야 합니다.`);
      return;
    }
    if (!isSafeExternalUrl(item.link_url)) {
      errors.push(`${label}.link_url은 비워두거나 올바른 http(s) 외부 URL을 입력해야 합니다.`);
    }
  }

  const inlineFormattingTags = ['strong', 'em', 'sup', 'sub'];
  const maxRichTextLength = 20_000;
  const maxRichTextTokens = 1_000;

  function hasVisibleInlineText(value) {
    return /[^\s\u200B-\u200D\u2060\uFEFF]/u.test(value);
  }

  function validateInlineMarkup(value, label, errors) {
    if (typeof value !== 'string' || value.trim() === '') return;
    if (value.length > maxRichTextLength) {
      errors.push(`${label}은 ${maxRichTextLength.toLocaleString()}자 이하여야 합니다.`);
      return;
    }

    const allowedMarkup = inlineFormattingTags.map((tag) => `<${tag}>...</${tag}>`).join(' 또는 ');
    const tokenPattern = /<[^>]*>|[<>]/g;
    const exactTagPattern = /^<(\/?)((?:strong|em|sup|sub))>$/;
    const stack = [];
    let cursor = 0;
    let visibleText = '';
    let tokenCount = 0;
    let match;

    while ((match = tokenPattern.exec(value)) !== null) {
      const textBeforeTag = value.slice(cursor, match.index);
      visibleText += textBeforeTag;
      if (hasVisibleInlineText(textBeforeTag)) stack.forEach((entry) => { entry.hasVisibleText = true; });
      cursor = match.index + match[0].length;
      tokenCount += 1;
      if (tokenCount > maxRichTextTokens) {
        errors.push(`${label}에는 서식 태그를 ${maxRichTextTokens.toLocaleString()}개까지만 사용할 수 있습니다.`);
        return;
      }

      const tagMatch = exactTagPattern.exec(match[0]);
      if (!tagMatch) {
        errors.push(`${label}에는 속성이 없는 소문자 ${allowedMarkup} 태그만 사용할 수 있습니다.`);
        return;
      }

      const closing = tagMatch[1] === '/';
      const tag = tagMatch[2];
      if (closing) {
        const active = stack[stack.length - 1];
        if (!active || active.tag !== tag) {
          errors.push(`${label}의 서식 태그는 여는 태그와 닫는 태그의 짝이 맞아야 하며, 같은 태그와 <sup>/<sub>는 중첩할 수 없습니다.`);
          return;
        }
        if (!active.hasVisibleText) {
          errors.push(`${label}의 각 서식 태그 안에는 표시할 텍스트가 있어야 합니다.`);
          return;
        }
        stack.pop();
      } else {
        const repeatsTag = stack.some((entry) => entry.tag === tag);
        const mixesScriptLevel = (tag === 'sup' && stack.some((entry) => entry.tag === 'sub'))
          || (tag === 'sub' && stack.some((entry) => entry.tag === 'sup'));
        if (repeatsTag || mixesScriptLevel) {
          errors.push(`${label}의 서식 태그는 여는 태그와 닫는 태그의 짝이 맞아야 하며, 같은 태그와 <sup>/<sub>는 중첩할 수 없습니다.`);
          return;
        }
        stack.push({ tag, hasVisibleText: false });
      }
    }

    const trailingText = value.slice(cursor);
    visibleText += trailingText;
    if (hasVisibleInlineText(trailingText)) stack.forEach((entry) => { entry.hasVisibleText = true; });
    if (stack.length) {
      errors.push(`${label}의 서식 태그는 여는 태그와 닫는 태그의 짝이 맞아야 하며, 같은 태그와 <sup>/<sub>는 중첩할 수 없습니다.`);
      return;
    }
    if (!hasVisibleInlineText(visibleText)) errors.push(`${label}에는 표시할 텍스트가 있어야 합니다.`);
  }

  function validateInlineFields(record, fields, label, errors) {
    fields.forEach((field) => {
      if (!isRecord(record) || !Object.prototype.hasOwnProperty.call(record, field)) return;
      if (typeof record[field] !== 'string') {
        errors.push(`${label}.${field}는 문자열이어야 합니다.`);
        return;
      }
      validateInlineMarkup(record[field], `${label}.${field}`, errors);
    });
  }

  function validateInlineStringArray(record, field, label, errors) {
    if (!Array.isArray(record?.[field])) return;
    record[field].forEach((entry, index) => validateInlineMarkup(entry, `${label}.${field}.${index}`, errors));
  }

  const imageDisplayKeys = ['positionX', 'positionY', 'zoom'];

  function validateImageDisplay(display, label, errors) {
    if (!isRecord(display)) {
      errors.push(`${label}은 이미지 표시 설정 객체여야 합니다.`);
      return;
    }
    Object.keys(display).forEach((key) => {
      if (!imageDisplayKeys.includes(key)) errors.push(`${label}.${key}는 지원하지 않는 설정입니다.`);
    });
    imageDisplayKeys.forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(display, key) || typeof display[key] !== 'number' || !Number.isFinite(display[key])) {
        errors.push(`${label}.${key}는 유한한 숫자여야 합니다.`);
      }
    });
    if (Number.isFinite(display.positionX) && (display.positionX < 0 || display.positionX > 100)) {
      errors.push(`${label}.positionX는 0에서 100 사이여야 합니다.`);
    }
    if (Number.isFinite(display.positionY) && (display.positionY < 0 || display.positionY > 100)) {
      errors.push(`${label}.positionY는 0에서 100 사이여야 합니다.`);
    }
    if (Number.isFinite(display.zoom) && (display.zoom < 1 || display.zoom > 4)) {
      errors.push(`${label}.zoom은 1에서 4 사이여야 합니다.`);
    }
  }

  function validateOptionalImageDisplay(item, field, label, errors) {
    if (!Object.prototype.hasOwnProperty.call(item, field)) return;
    validateImageDisplay(item[field], `${label}.${field}`, errors);
  }

  function validate(value) {
    const errors = [];
    if (!isRecord(value)) return { valid: false, errors: ['최상위 데이터는 객체여야 합니다.'] };

    ['site', 'home', 'professor'].forEach((key) => {
      if (!isRecord(value[key])) errors.push(`${key}는 객체여야 합니다.`);
    });

    validateOptionalPageContent(value, errors);
    if (typeof value.researchStatement !== 'string') {
      errors.push('content.researchStatement는 문자열이어야 합니다.');
    } else {
      validateInlineMarkup(value.researchStatement, 'content.researchStatement', errors);
    }

    if (isRecord(value.site)) {
      validateInlineFields(
        value.site,
        ['labName', 'labNameKr', 'university', 'universityKr', 'address', 'copyright', 'joinMessage'],
        'site',
        errors,
      );
    }

    if (isRecord(value.site) && Object.prototype.hasOwnProperty.call(value.site, 'subHeroImages')) {
      const subHeroImages = value.site.subHeroImages;
      if (!isRecord(subHeroImages)) {
        errors.push('site.subHeroImages는 객체여야 합니다.');
      } else {
        Object.keys(subHeroImages).forEach((key) => {
          if (!subHeroPageKeys.includes(key)) errors.push(`site.subHeroImages.${key}는 지원하지 않는 페이지입니다.`);
        });
        subHeroPageKeys.forEach((key) => {
          if (Object.prototype.hasOwnProperty.call(subHeroImages, key) && typeof subHeroImages[key] !== 'string') {
            errors.push(`site.subHeroImages.${key}는 문자열이어야 합니다.`);
          }
        });
      }
    }

    const recordArrays = ['researchTopics', 'members', 'alumni', 'publications', 'patents', 'gallery'];
    recordArrays.forEach((key) => {
      if (!Array.isArray(value[key])) {
        errors.push(`${key}는 배열이어야 합니다.`);
        return;
      }
      if (!value[key].every(isRecord)) errors.push(`${key}의 모든 항목은 객체여야 합니다.`);
    });

    if (isRecord(value.home)) {
      if (!Array.isArray(value.home.titleLines)) {
        errors.push('home.titleLines는 배열이어야 합니다.');
      } else if (!value.home.titleLines.every((item) => typeof item === 'string')) {
        errors.push('home.titleLines의 모든 항목은 문자열이어야 합니다.');
      }
      validateInlineFields(value.home, ['eyebrow', 'subtitleKr', 'tagline', 'intro', 'ctaPrimary', 'ctaSecondary'], 'home', errors);
      validateInlineStringArray(value.home, 'titleLines', 'home', errors);
    }

    if (isRecord(value.professor)) {
      ['interest', 'education', 'experience'].forEach((key) => {
        if (value.professor[key] != null) {
          if (!Array.isArray(value.professor[key])) {
            errors.push(`professor.${key}는 배열이어야 합니다.`);
          } else if (!value.professor[key].every((item) => typeof item === 'string')) {
            errors.push(`professor.${key}의 모든 항목은 문자열이어야 합니다.`);
          }
        }
      });
      validateInlineFields(value.professor, ['name', 'role', 'department'], 'professor', errors);
      ['interest', 'education', 'experience']
        .forEach((field) => validateInlineStringArray(value.professor, field, 'professor', errors));
      validateOptionalImageDisplay(value.professor, 'photoDisplay', 'professor', errors);
    }

    if (Array.isArray(value.researchTopics)) {
      value.researchTopics.forEach((item, index) => {
        if (isRecord(item)) validateInlineFields(item, ['title', 'short', 'description'], `researchTopics.${index}`, errors);
      });
    }

    if (Array.isArray(value.members)) {
      value.members.forEach((item, index) => {
        if (!isRecord(item)) return;
        const label = `members.${index}`;
        validateInlineFields(item, ['name', 'role', 'period', 'research'], label, errors);
        validateOptionalImageDisplay(item, 'photoDisplay', label, errors);
      });
    }

    if (Array.isArray(value.alumni)) {
      value.alumni.forEach((item, index) => {
        if (isRecord(item)) validateInlineFields(item, ['name', 'next'], `alumni.${index}`, errors);
      });
    }

    if (Array.isArray(value.gallery)) {
      value.gallery.forEach((item, index) => {
        if (isRecord(item)) {
          if (!Array.isArray(item.images)) {
            errors.push(`gallery.${index}.images는 배열이어야 합니다.`);
          } else if (item.images.length === 0) {
            errors.push(`gallery.${index}에는 이미지를 한 장 이상 추가해야 합니다.`);
          } else if (!item.images.every((image) => typeof image === 'string' && image.trim() !== '')) {
            errors.push(`gallery.${index}.images의 모든 항목은 비어 있지 않은 이미지여야 합니다.`);
          }
          if (Array.isArray(item.images) && item.images.length > 0 && item.image !== item.images[0]) {
            errors.push(`gallery.${index}.image는 첫 번째 갤러리 이미지와 같아야 합니다.`);
          }
          if (Object.prototype.hasOwnProperty.call(item, 'imageDisplays')) {
            if (!Array.isArray(item.imageDisplays)) {
              errors.push(`gallery.${index}.imageDisplays는 배열이어야 합니다.`);
            } else {
              if (Array.isArray(item.images) && item.imageDisplays.length !== item.images.length) {
                errors.push(`gallery.${index}.imageDisplays는 images와 길이가 같아야 합니다.`);
              }
              item.imageDisplays.forEach((display, displayIndex) => {
                validateImageDisplay(display, `gallery.${index}.imageDisplays.${displayIndex}`, errors);
              });
            }
          }
          ['date', 'title'].forEach((field) => {
            if (typeof item[field] !== 'string' || item[field].trim() === '') {
              errors.push(`gallery.${index}.${field}는 필수 항목입니다.`);
            }
          });
          validateInlineFields(item, ['title', 'summary', 'body'], `gallery.${index}`, errors);
        }
      });
    }

    if (Array.isArray(value.publications)) {
      const seenNumbers = new Set();
      value.publications.forEach((item, index) => {
        if (!isRecord(item)) return;
        if (!Number.isInteger(item.number) || item.number <= 0) {
          errors.push(`publications.${index}.number는 1 이상의 정수여야 합니다.`);
        } else if (seenNumbers.has(item.number)) {
          errors.push(`publications.${index}.number ${item.number}가 중복되었습니다.`);
        } else {
          seenNumbers.add(item.number);
        }
        ['year', 'title', 'authors', 'journal'].forEach((field) => {
          if (typeof item[field] !== 'string' || item[field].trim() === '') {
            errors.push(`publications.${index}.${field}는 필수 항목입니다.`);
          }
        });
        validateInlineFields(item, ['title', 'authors', 'journal', 'note'], `publications.${index}`, errors);
        validateOptionalExternalUrl(item, `publications.${index}`, errors);
      });
    }

    if (Array.isArray(value.patents)) {
      value.patents.forEach((item, index) => {
        if (!isRecord(item)) return;
        validateInlineFields(item, ['title', 'inventors'], `patents.${index}`, errors);
        validateOptionalExternalUrl(item, `patents.${index}`, errors);
      });
    }

    return { valid: errors.length === 0, errors };
  }

  function assertValid(value) {
    const result = validate(value);
    if (!result.valid) throw new Error(result.errors.join(' '));
    return value;
  }

  global.EMLDataSchema = Object.freeze({ validate, assertValid });
})(window);
