import Fastify from 'fastify';
import { GraphQLClient, gql } from 'graphql-request';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import pool from './db.js';

dotenv.config();


const fastify = Fastify({ logger: true });

// Configuração da AniList API
const graphqlClient = new GraphQLClient('https://graphql.anilist.co');

// Query GraphQL para AniList
const gqlQuery = gql`
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
      coverImage {
        extraLarge
      }
      bannerImage
    }
  }
`;


fastify.get('/search', async (req, reply) => {
  const { query } = req.query;
  if (!query) {
    return reply.status(400).send({ error: 'Query é obrigatória.' });
  }

  try {
    // Verificar se o banco de dados já tem o anime
    const [rows] = await pool.query(
      'SELECT * FROM animes WHERE title_romaji LIKE ? OR description LIKE ?',
      [`%${query}%`, `%${query}%`]
    );

    if (rows.length > 0) {
      return reply.send({ source: 'database', results: rows });
    }

    // Caso não tenha no banco, buscar na AniList API
    const gqlQuery = gql`
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
          coverImage {
            extraLarge
          }
          bannerImage
        }
      }
    `;

    const variables = { search: query };
    const response = await graphqlClient.request(gqlQuery, variables);
    const anime = response.Media;

    // Tradução da descrição usando DeepL
    const descriptionPt = await translateText(anime.description, 'PT');

    // Salvar no banco de dados
    await pool.query(
      `INSERT INTO animes (
        id, title_romaji, title_english, title_native, description, genres, cover_image, banner_image
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        anime.id,
        anime.title.romaji || null,
        anime.title.english || null,
        anime.title.native || null,
        descriptionPt,
        anime.genres.join(', '),
        anime.coverImage.extraLarge,
        anime.bannerImage,
      ]
    );

    // Retornar os dados
    reply.send({
      source: 'api',
      results: [{
        id: anime.id,
        title: anime.title,
        description: descriptionPt,
        genres: anime.genres,
        coverImage: anime.coverImage.extraLarge,
        bannerImage: anime.bannerImage,
      }],
    });
  } catch (error) {
    console.error('Erro ao processar a rota /search:', error);
    reply.status(500).send({ error: 'Erro interno do servidor.' });
  }
});


// Função de tradução com DeepL
async function translateText(text, targetLang) {
  const response = await fetch('https://api-free.deepl.com/v2/translate', {
    method: 'POST',
    headers: {
      Authorization: `DeepL-Auth-Key ${process.env.DEEPL_API_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ text, target_lang: targetLang }),
  });
  const data = await response.json();
  return data.translations[0].text;
}

// Inicializar o servidor
fastify.listen({ port: 3000 }, (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  fastify.log.info(`Servidor rodando em ${address}`);
});
