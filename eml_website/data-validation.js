(function (global) {
  'use strict';

  const subHeroPageKeys = ['research', 'members', 'publications', 'gallery', 'contact'];

  function isRecord(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  function validate(value) {
    const errors = [];
    if (!isRecord(value)) return { valid: false, errors: ['최상위 데이터는 객체여야 합니다.'] };

    ['site', 'home', 'professor'].forEach((key) => {
      if (!isRecord(value[key])) errors.push(`${key}는 객체여야 합니다.`);
    });

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
          ['date', 'title'].forEach((field) => {
            if (typeof item[field] !== 'string' || item[field].trim() === '') {
              errors.push(`gallery.${index}.${field}는 필수 항목입니다.`);
            }
          });
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
