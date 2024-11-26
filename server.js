import Fastify from 'fastify';
import { GraphQLClient, gql } from 'graphql-request';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import sanitizeHtml from 'sanitize-html';
import mysql from 'mysql2/promise';
import pool from './db.js';

dotenv.config();

const fastify = Fastify({ logger: true });

// Configuração da AniList API com tempo limite
const graphqlClient = new GraphQLClient('https://graphql.anilist.co', {
  timeout: 5000, // 5 segundos de tempo limite
});

const gqlQueryWithEpisodes = gql`
  query ($search: String) {
    Media(search: $search, type: ANIME) {
      id
      title {
        romaji
        english
        native
      }
      description
      genres
      episodes
      coverImage {
        extraLarge
      }
      bannerImage
      streamingEpisodes {
        title
        thumbnail
      }
    }
  }
`;

// Query GraphQL para AniList com paginação
const gqlQuery = gql`
  query ($search: String, $page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      media(search: $search, type: ANIME) {
        id
        title {
          romaji
          english
          native
        }
        description
        genres
        episodes
        coverImage {
          extraLarge
        }
        bannerImage
        streamingEpisodes {
          title
          thumbnail
        }
      }
    }
  }
`;

fastify.get('/anime/search-titles', async (req, reply) => {
  const { query } = req.query;

  if (typeof query !== 'string' || query.trim() === '') {
    return reply.status(400).send({ error: 'A consulta deve ser uma string não vazia.' });
  }

  // Preservando caracteres Unicode
  const sanitizedQuery = query.replace(/[^\p{L}\p{N}\s]/gu, '').trim();

  try {
    // Buscar no banco apenas os títulos e IDs
    const [rows] = await pool.query(
      `SELECT id, title_romaji, title_english, title_native
       FROM animes
       WHERE title_romaji LIKE ?
          OR title_english LIKE ?
          OR title_native LIKE ?`,
      [`%${sanitizedQuery}%`, `%${sanitizedQuery}%`, `%${sanitizedQuery}%`]
    );

    if (rows.length > 0) {
      // Retornar apenas ID e títulos encontrados no banco
      return reply.send({ source: 'database', results: rows });
    }

    // Caso não encontre resultados, retornar uma mensagem para buscar na API
    return reply.send({
      source: 'database',
      results: [],
      message: 'Nenhum título encontrado no banco. Tente buscar na API AniList.',
    });
  } catch (error) {
    console.error('Erro ao buscar títulos no banco:', error);
    reply.status(500).send({ error: 'Erro interno do servidor.' });
  }
});

fastify.get('/anime/search-api', async (req, reply) => {
  const { query, page = 1, perPage = 10 } = req.query;

  if (typeof query !== 'string' || query.trim() === '') {
    return reply.status(400).send({ error: 'A consulta deve ser uma string não vazia.' });
  }

  // Preservando caracteres Unicode
  const sanitizedQuery = query.replace(/[^\p{L}\p{N}\s]/gu, '').trim();

  try {
    // Buscar diretamente na API AniList com paginação
    const variables = {
      search: sanitizedQuery,
      page: parseInt(page),
      perPage: parseInt(perPage),
    };
    const response = await graphqlClient.request(gqlQuery, variables);
    const animes = response.Page.media;

    if (!animes || animes.length === 0) {
      return reply.status(404).send({ error: 'Nenhum anime encontrado na API.' });
    }

    // Inserir os títulos encontrados no banco, se ainda não existirem
    const animeValues = animes.map(anime => [
      anime.id,
      anime.title.romaji || null,
      anime.title.english || 'N/A',
      anime.title.native || null,
    ]);

    await pool.query(
      `INSERT INTO animes (id, title_romaji, title_english, title_native)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         title_romaji = VALUES(title_romaji),
         title_english = VALUES(title_english),
         title_native = VALUES(title_native)`,
      [animeValues]
    );

    // Retornar apenas ID e títulos
    reply.send({
      source: 'api',
      results: animes.map(anime => ({
        id: anime.id,
        title_romaji: anime.title.romaji,
        title_english: anime.title.english,
        title_native: anime.title.native,
      })),
    });
  } catch (error) {
    console.error('Erro ao buscar na API:', error);
    reply.status(500).send({ error: 'Erro interno do servidor.' });
  }
});

fastify.get('/anime/name', async (req, reply) => {
  const { query, page = 1, limit = 10 } = req.query;

  if (typeof query !== 'string' || query.trim() === '') {
    return reply.status(400).send({ error: 'A consulta deve ser uma string não vazia.' });
  }

  // Preservando caracteres Unicode
  const sanitizedQuery = query.replace(/[^\p{L}\p{N}\s]/gu, '').trim();
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    // Buscar no banco de dados
    const [rows] = await pool.query(
      `SELECT * FROM animes 
       WHERE title_romaji LIKE ? 
          OR title_english LIKE ? 
          OR title_native LIKE ?
       LIMIT ? OFFSET ?`,
      [`%${sanitizedQuery}%`, `%${sanitizedQuery}%`, `%${sanitizedQuery}%`, parseInt(limit), parseInt(offset)]
    );

    if (rows.length > 0) {
      // Buscar episódios no banco para cada anime encontrado
      const animeResults = await Promise.all(
        rows.map(async (anime) => {
          const [episodes] = await pool.query(
            `SELECT episode_number, title_romaji, title_translated, thumbnail_image
             FROM anime_episodes WHERE anime_id = ?`,
            [anime.id]
          );
          return {
            anime,
            episodes,
          };
        })
      );

      // Retornar os registros encontrados no banco
      return reply.send({ source: 'database', results: animeResults, page: parseInt(page), limit: parseInt(limit) });
    }

    // Caso não tenha no banco, buscar na AniList API
    const variables = { search: sanitizedQuery };
    const response = await graphqlClient.request(gqlQueryWithEpisodes, variables);
    const anime = response.Media;

    if (!anime) {
      return reply.status(404).send({ error: 'Anime não encontrado na AniList API.' });
    }

    // Tradução da descrição usando DeepL
    const descriptionPt = await translateText(anime.description || '', 'PT-BR');
    const cleanDescription = sanitizeHtml(descriptionPt, { allowedTags: [], allowedAttributes: {} });

    // Processar episódios e preparar para batch insert
    const episodes = anime.streamingEpisodes?.map((ep, index) => ({
      anime_id: anime.id,
      episode_number: index + 1,
      title_romaji: ep.title || null,
      thumbnail_image: ep.thumbnail || null,
    })) || [];

    // Traduzir títulos dos episódios
    const translatedTitles = await Promise.all(
      episodes.map(async (ep) => {
        const translatedTitle = await translateText(ep.title_romaji || '', 'PT-BR');
        return sanitizeHtml(translatedTitle, { allowedTags: [], allowedAttributes: {} }) || 'Sem título';
      })
    );

    // Adicionar títulos traduzidos aos episódios
    episodes.forEach((ep, index) => {
      ep.title_translated = translatedTitles[index];
    });

    // Inserir episódios em batch
    if (episodes.length > 0) {
      const episodeValues = episodes.map(ep => [
        ep.anime_id,
        ep.episode_number,
        ep.title_romaji,
        ep.title_translated,
        ep.thumbnail_image,
      ]);

      await pool.query(
        `INSERT INTO anime_episodes (anime_id, episode_number, title_romaji, title_translated, thumbnail_image)
         VALUES ?
         ON DUPLICATE KEY UPDATE
           title_romaji = VALUES(title_romaji),
           title_translated = VALUES(title_translated),
           thumbnail_image = VALUES(thumbnail_image)`,
        [episodeValues]
      );
    }

    // Inserir ou atualizar o anime no banco
    await pool.query(
      `INSERT INTO animes (id, title_romaji, title_english, title_native, description, genres, cover_image, banner_image, episodes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         title_romaji = VALUES(title_romaji),
         title_english = VALUES(title_english),
         title_native = VALUES(title_native),
         description = VALUES(description),
         genres = VALUES(genres),
         cover_image = VALUES(cover_image),
         banner_image = VALUES(banner_image),
         episodes = VALUES(episodes)`,
      [
        anime.id,
        anime.title.romaji || null,
        anime.title.english || 'N/A',
        anime.title.native || null,
        cleanDescription || 'Sem descrição',
        anime.genres?.join(', ') || 'Gêneros desconhecidos',
        anime.coverImage?.extraLarge || null,
        anime.bannerImage || null,
        anime.episodes || 0,
      ]
    );

    // Retornar os dados do anime e episódios
    reply.send({
      source: 'api',
      results: [{
        anime: {
          id: anime.id,
          title: anime.title,
          description: cleanDescription,
          genres: anime.genres,
          episodes: anime.episodes,
          coverImage: anime.coverImage?.extraLarge,
          bannerImage: anime.bannerImage,
        },
        episodes: episodes.map(ep => ({
          number: ep.episode_number,
          title_romaji: ep.title_romaji,
          title_translated: ep.title_translated,
          thumbnail: ep.thumbnail_image,
        })),
      }],
      page: 1,
      limit: 1,
    });
  } catch (error) {
    console.error('Erro ao processar a rota /anime/name:', error);
    reply.status(500).send({ error: 'Erro interno do servidor.' });
  }
});

// Função de tradução com DeepL
async function translateText(text, targetLang) {
  try {
    const response = await fetch('https://api-free.deepl.com/v2/translate', {
      method: 'POST',
      headers: {
        Authorization: `DeepL-Auth-Key ${process.env.DEEPL_API_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ text, target_lang: targetLang }),
    });

    if (!response.ok) {
      throw new Error(`Erro na tradução: ${response.statusText}`);
    }

    const data = await response.json();
    return data.translations[0]?.text || 'Tradução indisponível';
  } catch (error) {
    console.error('Erro na tradução:', error);
    return 'Tradução indisponível';
  }
}

// Inicializar o servidor
fastify.listen({ port: 3000 }, (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  fastify.log.info(`Servidor rodando em ${address}`);
});
