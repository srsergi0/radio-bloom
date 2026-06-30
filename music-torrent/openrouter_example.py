#!/usr/bin/env python3
"""
Ejemplo: Conectar OpenRouter con MCP tools de music-torrent
"""
import os
import json
import requests

# Configuración
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "tu-api-key-aqui")
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

# Definir las tools que el LLM puede usar
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_torrents",
            "description": "Buscar torrents de música en The Pirate Bay",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Búsqueda (artista - canción)"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Número de resultados",
                        "default": 5
                    }
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "queue_download",
            "description": "Agregar una descarga a la cola",
            "parameters": {
                "type": "object",
                "properties": {
                    "magnet": {
                        "type": "string",
                        "description": "Link magnet"
                    },
                    "name": {
                        "type": "string",
                        "description": "Nombre para la descarga"
                    }
                },
                "required": ["magnet", "name"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "check_status",
            "description": "Verificar estado de una descarga",
            "parameters": {
                "type": "object",
                "properties": {
                    "job_id": {
                        "type": "string",
                        "description": "ID del trabajo"
                    }
                },
                "required": ["job_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "queue_status",
            "description": "Estado general de la cola de descargas",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    }
]


def call_tool(tool_name: str, arguments: dict) -> dict:
    """Simular llamada a tool MCP (en producción, usarías el cliente MCP real)."""
    import sys
    sys.path.insert(0, "D:/cursos/SEED-AUDIO/radio/music-torrent")
    
    if tool_name == "search_torrents":
        from queue_manager import search_torrents
        return search_torrents(arguments["query"], arguments.get("limit", 5))
    elif tool_name == "queue_download":
        from queue_manager import add_to_queue
        job_id = add_to_queue(arguments["magnet"], arguments["name"])
        return {"job_id": job_id, "status": "queued"}
    elif tool_name == "check_status":
        from queue_manager import get_job_status
        return get_job_status(arguments["job_id"])
    elif tool_name == "queue_status":
        from queue_manager import get_queue_status
        return get_queue_status()
    else:
        return {"error": f"Unknown tool: {tool_name}"}


def chat_with_tools(user_message: str) -> str:
    """Enviar mensaje al LLM con soporte para tools."""
    messages = [
        {"role": "system", "content": "Eres un asistente que puede buscar y descargar música usando torrents. Usa las tools disponibles para ayudar al usuario."},
        {"role": "user", "content": user_message}
    ]
    
    # Primer request al LLM
    response = requests.post(
        OPENROUTER_URL,
        headers={
            "Authorization": f"Bearer {OPENROUTER_API_KEY}",
            "Content-Type": "application/json"
        },
        json={
            "model": "openai/gpt-4",
            "messages": messages,
            "tools": TOOLS,
            "tool_choice": "auto"
        }
    )
    
    result = response.json()
    
    # Verificar si el LLM quiere usar una tool
    if result["choices"][0]["message"].get("tool_calls"):
        tool_calls = result["choices"][0]["message"]["tool_calls"]
        
        # Ejecutar cada tool call
        for tool_call in tool_calls:
            function_name = tool_call["function"]["name"]
            arguments = json.loads(tool_call["function"]["arguments"])
            
            print(f"\n🔧 Ejecutando tool: {function_name}")
            print(f"   Argumentos: {arguments}")
            
            # Ejecutar la tool
            tool_result = call_tool(function_name, arguments)
            
            print(f"   Resultado: {tool_result}")
            
            # Agregar resultado al historial
            messages.append(result["choices"][0]["message"])
            messages.append({
                "role": "tool",
                "tool_call_id": tool_call["id"],
                "content": json.dumps(tool_result)
            })
        
        # Segundo request al LLM con resultados de las tools
        response = requests.post(
            OPENROUTER_URL,
            headers={
                "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                "Content-Type": "application/json"
            },
            json={
                "model": "openai/gpt-4",
                "messages": messages,
                "tools": TOOLS,
                "tool_choice": "auto"
            }
        )
        
        result = response.json()
    
    # Retornar respuesta final
    return result["choices"][0]["message"]["content"]


def main():
    """Ejemplo de uso."""
    print("=== Music Torrent + OpenRouter ===\n")
    
    # Ejemplo 1: Buscar música
    print("Usuario: Busca After Midnight de Chappell Roan\n")
    response = chat_with_tools("Busca After Midnight de Chappell Roan")
    print(f"LLM: {response}\n")
    
    # Ejemplo 2: Estado de la cola
    print("Usuario: ¿Cuál es el estado de la cola?\n")
    response = chat_with_tools("¿Cuál es el estado de la cola de descargas?")
    print(f"LLM: {response}\n")


if __name__ == "__main__":
    main()
